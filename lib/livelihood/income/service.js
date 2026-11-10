'use strict';

/**
 * 人均收入与支出序列服务：缓存优先——首次运行一次拉全历史，之后只补新落下的年度
 *
 * 动作与 lib/livelihood/service 一致：
 *   ensure(indicator, {from,to,force})  按策略判断是否要拉，拉完写缓存
 *   points(indicator, from, to)         从缓存拼出按年序列（缺年补 null）
 *   overview({from,to,force})           一次性给前端全部指标
 *
 * 远端按「栏目」批量取数：23 个指标落在 6 个栏目里，所以首屏最多 6 个请求。
 * 同栏目第一个指标拉回来的数据会写进该栏目所有指标的缓存，
 * 后续指标判断「已覆盖」就不再单独请求。
 */

const config = require('./config');
const store = require('./store');
const policy = require('../policy');
const nbs = require('../source');
const { blocked, mark } = require('../queue');

/** 年度序列：['2019','2020', ...] 含首尾 */
function yearRange(from, to) {
  const out = [];
  for (let y = Number(from); y <= Number(to) && out.length < 200; y += 1) out.push(String(y));
  return out;
}

/** 原值即展示值：元 / % 都不做换算，只统一精度 */
function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  return Math.round(raw * 100) / 100;
}

function decimalsOf(indicator) {
  return typeof indicator.decimals === 'number' ? indicator.decimals : 2;
}

/** 栏目下所有指标成员（用于批量取数） */
function membersOfCatalog(catalogKey) {
  const out = [];
  config.list().forEach((indicator) => {
    if (indicator.catalog === catalogKey) out.push(indicator);
  });
  return out;
}

const inflight = new Map();

/**
 * 按需拉取一个栏目（同栏目并发请求复用同一个 Promise）
 * @returns {Promise<{ok:boolean, error?:string, years:number, source:string}>}
 */
function warmCatalog(catalogKey, p) {
  const key = catalogKey + '|' + p.from + '|' + p.to;
  if (inflight.has(key)) return inflight.get(key);
  const task = (async () => {
    const cat = config.getCatalog(catalogKey);
    const members = membersOfCatalog(catalogKey);
    if (!members.length) return { ok: false, error: '栏目下没有配置指标: ' + catalogKey, years: 0 };

    const from = p.from;
    const to = p.to;
    if (from > to) return { ok: true, years: 0 };

    const ids = [];
    members.forEach((m) => {
      if (ids.indexOf(m.indicatorId) === -1) ids.push(m.indicatorId);
    });

    const data = await nbs.fetchRange({ catalogId: cat.id, indicatorIds: ids, from, to });
    const fetchedAt = new Date().toISOString();
    let written = 0;

    members.forEach((m) => {
      const map = data[m.indicatorId] || {};
      Object.keys(map).forEach((year) => {
        if (year < from || year > to) return;
        store.writeYear(m.id, year, { raw: map[year], source: 'nbs', fetchedAt });
        written += 1;
      });
      const meta = store.readMeta(m.id) || {};
      // 同栏目是一次请求带回来的：把同组指标的「上次尝试」一起打上，
      // 否则组内其余指标会以为自己还没核过，对着同一份数据反复回源
      store.writeMeta(
        m.id,
        Object.assign({}, meta, {
          lastAttempt: fetchedAt,
          lastSuccess: fetchedAt,
          lastSource: 'nbs',
          lastError: null,
        })
      );
    });

    return { ok: true, years: written, source: 'nbs' };
  })()
    .catch((e) => ({ ok: false, error: e.message || String(e), years: 0 }))
    .then((r) => {
      inflight.delete(key);
      return r;
    });
  inflight.set(key, task);
  return task;
}

/**
 * 按策略补数据；永不抛错（失败只记录，交给上层标 stale）
 */
async function ensure(indicator, opts) {
  const o = opts || {};
  const history = config.historyRange();
  const expectedLatest = policy.expectedLatestYear(new Date());
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;
  if (from > to) return { fetched: false, reason: '区间为空' };

  const cached = store.listYears(indicator.id);
  const decision = policy.shouldFetch({
    cachedYears: cached,
    wantFrom: from,
    force: o.force,
  });

  // 缓存覆盖到需要的区间，且不强制刷新 → 直接返回
  if (!decision.fetch) return { fetched: false, reason: decision.reason };

  const prevMeta = store.readMeta(indicator.id) || {};

  // 距上次回源尝试不足 10 分钟 → 直接用缓存（这条限制落盘，进程重启后仍生效）
  if (!o.force && prevMeta.lastAttempt && Date.now() - Date.parse(prevMeta.lastAttempt) < policy.TRY_INTERVAL_MS) {
    return { fetched: false, reason: '距上次回源不足 ' + Math.round(policy.TRY_INTERVAL_MS / 60000) + ' 分钟' };
  }

  // 单指标 60 秒冷却：同一指标刚拉过就不再打扰上游（手动刷新也不会连击）
  if (blocked('inc:' + indicator.id, policy.COOLDOWN_MS)) {
    return { fetched: false, reason: '冷却中：同一指标 60 秒内不重复请求' };
  }

  // 预演：只回答「现在该不该真的发请求」，不改任何状态（overview 靠它决定要不要起后台任务）
  if (o.dryRun) return { fetched: false, pending: true, reason: decision.reason };

  mark('inc:' + indicator.id);
  store.writeMeta(indicator.id, Object.assign({}, prevMeta, { lastAttempt: new Date().toISOString() }));

  const r = await warmCatalog(indicator.catalog, { from: from, to: to });
  if (!r.ok) {
    const failMeta = store.readMeta(indicator.id) || {};
    store.writeMeta(
      indicator.id,
      Object.assign({}, failMeta, { lastError: r.error || '上游取数失败', lastAttempt: new Date().toISOString() })
    );
    return { fetched: false, reason: '主源失败，已回退缓存', errors: [r.error] };
  }

  return { fetched: r.years > 0, reason: decision.reason };
}

/** 从缓存拼序列：缺年用 null，不插值 */
function points(indicator, from, to) {
  return yearRange(from, to).map((year) => {
    const hit = store.readYear(indicator.id, year);
    const raw = hit && typeof hit.raw === 'number' ? hit.raw : null;
    return { year: year, raw: raw, value: toValue(indicator, raw), source: hit ? hit.source : null };
  });
}

function descriptor(indicator) {
  const history = config.historyRange();
  const cached = store.listYears(indicator.id);
  const meta = store.readMeta(indicator.id) || {};
  const expectedLatest = policy.expectedLatestYear(new Date());
  const latestCached = cached.length ? cached[cached.length - 1] : '';
  return {
    id: indicator.id,
    label: indicator.label,
    shortLabel: indicator.shortLabel || indicator.label,
    unit: indicator.unit,
    kind: indicator.kind,
    group: indicator.group || '',
    decimals: decimalsOf(indicator),
    note: indicator.note || '',
    historyFrom: history.from,
    expectedLatest: expectedLatest,
    latestCached: latestCached,
    stale: !latestCached || latestCached < expectedLatest || !!meta.lastError,
    source: meta.lastSource || (cached.length ? 'nbs' : ''),
    lastError: meta.lastError || '',
    lastSuccess: meta.lastSuccess || '',
  };
}

/** 单指标：先 ensure 再取数 */
async function getSeries(id, opts) {
  const o = opts || {};
  const indicator = config.byId(id);
  const history = config.historyRange();
  const expectedLatest = policy.expectedLatestYear(new Date());
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;

  const ensureResult = await ensure(indicator, { from: from, to: to, force: o.force });
  const pts = points(indicator, from, to);
  const desc = descriptor(indicator);
  const valid = pts.filter((x) => x.value !== null);
  return Object.assign({}, desc, {
    from: from,
    to: to,
    points: pts,
    latest: valid.length ? valid[valid.length - 1] : null,
    prev: valid.length > 1 ? valid[valid.length - 2] : null,
    fetched: ensureResult.fetched,
    fetchReason: ensureResult.reason || '',
  });
}

/** 后台补拉（stale-while-revalidate）：同一区间只跑一份，不重复堆任务 */
const bgJobs = new Map();

function refreshInBackground(list, from, to) {
  const key = from + '|' + to;
  if (bgJobs.has(key) || !list.length) return;
  const job = (async () => {
    for (const indicator of list) {
      await ensure(indicator, { from: from, to: to, force: false });
    }
  })();
  bgJobs.set(
    key,
    job.then(
      () => bgJobs.delete(key),
      () => bgJobs.delete(key)
    )
  );
}

function expectedLatestOf() {
  return policy.expectedLatestYear(new Date());
}

/** 全量（前端一次请求拿到所有图的数据） */
async function overview(opts) {
  const o = opts || {};
  const history = config.historyRange();
  const indicators = config.list();
  const expectedLatest = expectedLatestOf();
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;
  const from = o.from && o.from > history.from ? o.from : history.from;

  const startedAt = Date.now();
  let fetchedCount = 0;
  const errors = [];

  // 与宏观 / 婚育模块同款四分类：
  //   cold   —— 一个年度缓存都没有：首次运行，按全历史整段拉全，不受当前展示区间限制
  //   empty  —— 有缓存但当前区间是空的：等一下上游，否则首屏只能是空曲线
  //   behind —— 落后应发布年度 2 年以上（比如包放了几年才打开）：同步补齐再渲染
  //   warm   —— 有缓存且基本跟上：先用缓存出图，只在「应发布年度还没落缓存」时后台核对
  const behindCutoff = String(Number(expectedLatest) - 2);
  const warm = [];
  const empty = [];
  const behind = [];
  const cold = [];
  indicators.forEach((ind) => {
    const years = store.listYears(ind.id);
    if (!years.length) cold.push(ind);
    else if (!years.some((y) => y >= from && y <= to)) empty.push(ind);
    else if (years[years.length - 1] < behindCutoff) behind.push(ind);
    else warm.push(ind);
  });

  for (const indicator of o.force ? indicators : cold.concat(empty, behind)) {
    const bootstrap = cold.indexOf(indicator) !== -1 && !o.force;
    const r = await ensure(indicator, {
      from: bootstrap ? history.from : from,
      to: bootstrap ? expectedLatestOf() : to,
      force: o.force,
    });
    if (r.fetched) fetchedCount += 1;
    if (r.errors && r.errors.length) errors.push(indicator.id + ': ' + r.errors[0]);
  }

  const items = indicators.map((indicator) => {
    const pts = points(indicator, from, to);
    const desc = descriptor(indicator);
    const valid = pts.filter((x) => x.value !== null);
    return Object.assign({}, desc, {
      points: pts,
      latest: valid.length ? valid[valid.length - 1] : null,
      prev: valid.length > 1 ? valid[valid.length - 2] : null,
    });
  });

  // 手动刷新时上面已经全部 ensure 过了；平时把「现在真该回源」的指标丢后台补，
  // 首屏不等它：先用缓存出图，前端稍后再取一次就能拿到新数据。
  let refreshing = 0;
  if (!o.force) {
    for (const indicator of warm) {
      const probe = await ensure(indicator, { from: from, to: to, force: false, dryRun: true });
      if (probe.pending) refreshing += 1;
    }
    if (refreshing) refreshInBackground(warm, from, to);
    else if (bgJobs.has(from + '|' + to)) refreshing = warm.length || 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range: { from: from, to: to },
    fetched: fetchedCount,
    // >0 表示后台正在补数据：前端先展示缓存，稍后再取一次即可拿到新数据
    refreshing: refreshing,
    errors: errors,
    stale: items.some((x) => x.stale),
    groups: config.settings().groups,
    indicators: items,
    // true 表示这次请求是「首次运行」：刚把全部历史拉全并写入缓存
    firstRun: cold.length > 0,
    cache: store.stats(),
  };
}

/** 数据集概况：只读本地文件，不回源，供启动日志与健康检查使用 */
function datasetStatus() {
  const history = config.historyRange();
  const stats = store.stats();
  let latest = '';
  let behind = 0;
  config.list().forEach((indicator) => {
    const years = store.listYears(indicator.id);
    const last = years.length ? years[years.length - 1] : '';
    if (!last || last < expectedLatestOf()) behind += 1;
    if (last > latest) latest = last;
  });
  return {
    dir: stats.dir,
    files: stats.files,
    indicators: stats.indicators,
    historyFrom: history.from,
    latest: latest,
    behind: behind,
  };
}

module.exports = { ensure, points, descriptor, getSeries, overview, datasetStatus, toValue, yearRange };
