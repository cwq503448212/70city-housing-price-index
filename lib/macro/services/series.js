'use strict';

/**
 * 指标序列服务：缓存优先——首次运行一次拉全历史，之后只补新落下的期别
 *
 * 对外只暴露三个动作：
 *   ensure(indicator, {from,to,force})  按策略判断是否要拉，拉完写缓存
 *   points(indicator, from, to)         从缓存拼出按月序列（缺月补 null）
 *   overview({from,to,force})           一次性给前端全部指标（顶部时间选择就靠它）
 *
 * 远端按「栏目」批量取数：一个栏目一次请求可以带多个指标 id，
 * 这样 14 个指标只需要 6 次请求，既快又不容易触发站点风控。
 */

const config = require('../config');
const store = require('../cache/store');
const policy = require('../cache/policy');
const nbs = require('../sources/nbs');
const dbnomics = require('../sources/dbnomics');
const month = require('../util/month');
const { blocked, mark } = require('../util/queue');

/** 指数 → 涨跌幅：101.3 → +1.3；其他口径原样返回 */
function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  if (indicator.kind === 'index_yoy' || indicator.kind === 'index_mom') {
    return Math.round((raw - 100) * 100) / 100;
  }
  return Math.round(raw * 100) / 100;
}

function decimalsOf(indicator) {
  return typeof indicator.decimals === 'number' ? indicator.decimals : 1;
}

/** 指标在某栏目下的分段（interpolate 配置里的 from/to 缺省值） */
function segmentRange(indicator, segment) {
  const cat = config.getCatalog(segment.catalog);
  return {
    catalog: segment.catalog,
    catalogId: cat.id,
    indicatorId: segment.indicatorId,
    shown: segment.shown || '',
    from: segment.from || cat.from || config.historyRange().from,
    to: segment.to || cat.to || '9999-12',
  };
}

function segmentsFor(indicator, from, to) {
  return (indicator.segments || [])
    .map((seg) => segmentRange(indicator, seg))
    .filter((seg) => seg.to >= from && seg.from <= to);
}

/** 栏目下所有指标成员（用于批量取数） */
function membersOfCatalog(catalogKey) {
  const out = [];
  config.list().forEach((indicator) => {
    (indicator.segments || []).forEach((seg) => {
      if (seg.catalog !== catalogKey) return;
      const r = segmentRange(indicator, seg);
      out.push({ indicator, segment: r });
    });
  });
  return out;
}

const inflight = new Map();

/**
 * 按需拉取一个栏目（同栏目并发请求会复用同一个 Promise）
 * @returns {Promise<{ok:boolean, error?:string, months:number, source:string}>}
 */
function warmCatalog(catalogKey, p) {
  const key = catalogKey + '|' + p.from + '|' + p.to;
  if (inflight.has(key)) return inflight.get(key);
  const task = (async () => {
    const cat = config.getCatalog(catalogKey);
    const members = membersOfCatalog(catalogKey);
    if (!members.length) return { ok: false, error: '栏目下没有配置指标: ' + catalogKey, months: 0 };

    const from = p.from > (cat.from || p.from) ? p.from : cat.from || p.from;
    const to = cat.to && cat.to < p.to ? cat.to : p.to;
    if (from > to) return { ok: true, months: 0 };

    const ids = [];
    members.forEach((m) => {
      if (ids.indexOf(m.segment.indicatorId) === -1) ids.push(m.segment.indicatorId);
    });

    const data = await nbs.fetchRange({ catalogId: cat.id, indicatorIds: ids, from, to });
    const fetchedAt = new Date().toISOString();
    let written = 0;

    members.forEach((m) => {
      const map = data[m.segment.indicatorId] || {};
      Object.keys(map).forEach((mon) => {
        if (mon < from || mon > to) return;
        store.writeMonth(m.indicator.id, mon, { raw: map[mon], source: 'nbs', fetchedAt });
        written += 1;
      });
      const meta = store.readMeta(m.indicator.id) || {};
      store.writeMeta(m.indicator.id, Object.assign({}, meta, { lastSuccess: fetchedAt, lastSource: 'nbs', lastError: null }));
    });

    return { ok: true, months: written, source: 'nbs' };
  })()
    .catch((e) => ({ ok: false, error: e.message || String(e), months: 0 }))
    .then((r) => {
      inflight.delete(key);
      return r;
    });
  inflight.set(key, task);
  return task;
}

/** DBnomics 兜底：只在主源失败且缓存确实没有该月份时使用 */
async function warmFallback(indicator, p) {
  const list = [].concat(indicator.fallback || []);
  if (!list.length) return { ok: false, error: '该指标未配置 DBnomics 兜底' };
  const errors = [];
  let written = 0;
  for (const fb of list) {
    try {
      const map = await dbnomics.fetchSeries(fb);
      const fetchedAt = new Date().toISOString();
      Object.keys(map).forEach((mon) => {
        if (mon < p.from || mon > p.to) return;
        if (store.readMonth(indicator.id, mon)) return; // 不覆盖已有数据
        store.writeMonth(indicator.id, mon, { raw: map[mon], source: 'dbnomics', fetchedAt });
        written += 1;
      });
      const meta = store.readMeta(indicator.id) || {};
      store.writeMeta(indicator.id, Object.assign({}, meta, { lastFallback: fetchedAt, lastSource: 'dbnomics' }));
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  if (!written && errors.length) return { ok: false, error: errors.join(' / ') };
  return { ok: true, months: written, source: 'dbnomics' };
}

/**
 * 按策略补数据；永不抛错（失败只记录，交给上层标 stale）
 */
async function ensure(indicator, opts) {
  const o = opts || {};
  const history = config.historyRange();
  const expectedLatest = policy.expectedLatestMonth(indicator.release, new Date());
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;
  if (from > to) return { fetched: false, reason: '区间为空' };

  const cached = store.listMonths(indicator.id);
  const decision = policy.shouldFetch({
    cachedMonths: cached,
    release: indicator.release,
    wantFrom: from,
    exempt: indicator.exemptMonths,
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
  if (blocked('ind:' + indicator.id, policy.COOLDOWN_MS)) {
    return { fetched: false, reason: '冷却中：同一指标 60 秒内不重复请求' };
  }

  // 预演：只回答「现在该不该真的发请求」，不改任何状态（overview 靠它决定要不要起后台任务）
  if (o.dryRun) return { fetched: false, pending: true, reason: decision.reason };

  mark('ind:' + indicator.id);
  store.writeMeta(indicator.id, Object.assign({}, prevMeta, { lastAttempt: new Date().toISOString() }));

  const segments = segmentsFor(indicator, from, to);
  let fetched = false;
  const errors = [];

  for (const seg of segments) {
    // 分段自身区间裁剪
    const segFrom = from > seg.from ? from : seg.from;
    const segTo = to < seg.to ? to : seg.to;
    if (segFrom > segTo) continue;

    const r = await warmCatalog(seg.catalog, { from: segFrom, to: segTo });
    if (r.ok) fetched = fetched || r.months > 0;
    else errors.push(r.error);
  }

  if (errors.length) {
    const fb = await warmFallback(indicator, { from, to });
    if (!fb.ok) errors.push(fb.error);
    else fetched = fetched || fb.months > 0;
    const failMeta = store.readMeta(indicator.id) || {};
    store.writeMeta(
      indicator.id,
      Object.assign({}, failMeta, { lastError: errors.filter(Boolean).join(' / '), lastAttempt: new Date().toISOString() })
    );
  }

  return { fetched, reason: errors.length ? '主源失败，已回退缓存/兜底' : decision.reason, errors };
}

/** 从缓存拼序列：缺月用 null，不插值 */
function points(indicator, from, to) {
  const months = month.range(from, to);
  return months.map((m) => {
    const hit = store.readMonth(indicator.id, m);
    const raw = hit && typeof hit.raw === 'number' ? hit.raw : null;
    return { month: m, raw: raw, value: toValue(indicator, raw), source: hit ? hit.source : null };
  });
}

function descriptor(indicator) {
  const history = config.historyRange();
  const cached = store.listMonths(indicator.id);
  const meta = store.readMeta(indicator.id) || {};
  const expectedLatest = policy.expectedLatestMonth(indicator.release, new Date());
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
  const expectedLatest = policy.expectedLatestMonth(indicator.release, new Date());
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;

  const ensureResult = await ensure(indicator, { from, to, force: o.force });
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

/**
 * 后台补拉（stale-while-revalidate）
 *
 * 「有缓存、只是可能滞后」的指标不需要阻塞首屏：先用现有缓存出图，
 * 这里在后台把上游补一遍，写进缓存。同一区间只跑一份，不重复堆任务。
 */
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

/** 截至 now，该指标最晚应该已经发布的统计月 */
function expectedLatestOf(indicator) {
  return policy.expectedLatestMonth(indicator.release, new Date());
}

/** 全量（前端一次请求拿到所有图的数据） */
async function overview(opts) {
  const o = opts || {};
  const history = config.historyRange();
  const indicators = config.list();
  const expectedLatest = indicators.reduce((acc, ind) => {
    const e = expectedLatestOf(ind);
    return e > acc ? e : acc;
  }, history.from);
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;
  const from = o.from && o.from > history.from ? o.from : history.from;

  const startedAt = Date.now();
  let fetchedCount = 0;
  const errors = [];

  // 指标分四类：
  //   cold —— 一个月的缓存都没有：首次运行，按「全历史」整段拉全，不受当前展示区间限制
  //   empty —— 有缓存但当前区间是空的：等一下上游，否则首屏只能是空曲线
  //   behind —— 落后应发布期别 3 个月以上（比如拿了一份放了很久的包）：等它补完再渲染，
  //             否则后台补 10 期要十几秒，前端轮询早就停了，用户会一直看到旧图
  //   warm —— 有缓存且基本跟上：先用缓存出图，只在「应发布期别还没落缓存」时去后台核对
  const behindCutoff = month.addMonths(expectedLatest, -3);
  const warm = [];
  const empty = [];
  const behind = [];
  const cold = [];
  indicators.forEach((ind) => {
    const months = store.listMonths(ind.id);
    if (!months.length) cold.push(ind);
    else if (!months.some((m) => m >= from && m <= to)) empty.push(ind);
    else if (months[months.length - 1] < behindCutoff) behind.push(ind);
    else warm.push(ind);
  });

  for (const indicator of o.force ? indicators : cold.concat(empty, behind)) {
    const bootstrap = cold.indexOf(indicator) !== -1 && !o.force;
    const r = await ensure(indicator, {
      from: bootstrap ? history.from : from,
      to: bootstrap ? expectedLatestOf(indicator) : to,
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

  // 手动刷新时上面已经全部 ensure 过了；平时把「现在真该回源」的指标丢后台补。
  // 首屏不等它：先用缓存出图，前端稍后再取一次就能拿到新数据。
  let refreshing = 0;
  if (!o.force) {
    for (const indicator of warm) {
      const probe = await ensure(indicator, { from: from, to: to, force: false, dryRun: true });
      if (probe.pending) refreshing += 1;
    }
    if (refreshing) refreshInBackground(warm, from, to);
    // 上一轮后台任务还没跑完：继续让前端保持轮询，别让它在数据落地前就停
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

/**
 * 数据集概况：缓存覆盖到哪、有没有指标落后于应发布期别。
 * 只读本地文件，不回源，供启动日志、健康检查使用。
 */
function datasetStatus() {
  const history = config.historyRange();
  const stats = store.stats();
  let latest = '';
  let behind = 0;
  config.list().forEach((indicator) => {
    const months = store.listMonths(indicator.id);
    const last = months.length ? months[months.length - 1] : '';
    if (!last || last < expectedLatestOf(indicator)) behind += 1;
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

module.exports = { ensure, points, descriptor, getSeries, overview, datasetStatus, toValue };
