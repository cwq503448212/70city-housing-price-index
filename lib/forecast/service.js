'use strict';

/**
 * 推演模块序列服务：缓存优先——首次运行一次拉全历史，之后只补新落下的年度
 *
 * 对外动作与民生模块一致：
 *   ensure(indicator, {from,to,force})  按策略判断是否要拉，拉完写缓存
 *   points(indicator, from, to)         从缓存拼出按年序列（缺年补 null）
 *   overview({from,to,force})           一次性给前端「历史原值 + 推演结果」
 *
 * 落盘的只有官方原值；model.js 的结果每次现算，因为模型参数一改，
 * 历史对比线与预测线必须同时变，缓存里不能留旧结论。
 */

const config = require('./config');
const store = require('./store');
const policy = require('./policy');
const nbs = require('./source');
const model = require('./model');
const { blocked, mark } = require('./queue');

/** 年度序列：['2019','2020', ...] 含首尾 */
function yearRange(from, to) {
  const out = [];
  for (let y = Number(from); y <= Number(to) && out.length < 300; y += 1) out.push(String(y));
  return out;
}

function decimalsOf(indicator) {
  return typeof indicator.decimals === 'number' ? indicator.decimals : 1;
}

function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  const f = Math.pow(10, decimalsOf(indicator));
  return Math.round(raw * f) / f;
}

function clean(x) {
  return Math.round(x * 10000) / 10000;
}

/** 该指标「最晚应该已发布」的年度：价格类官方比销售类滞后一年 */
function capOf(indicator) {
  const expected = policy.expectedLatestYear(new Date());
  const lag = Number((indicator && indicator.lagYears) || 0);
  return lag > 0 ? String(Number(expected) - lag) : expected;
}

/**
 * 单年取值：原值读缓存，计算量现算（缺任一输入就是缺失，不补 0）
 *   rate_count  千分率 × 年平均人口 ÷ 1000（出生人口）
 */
function valueAt(indicator, year) {
  if (!indicator.derive) {
    const hit = store.readYear(indicator.id, year);
    return hit && typeof hit.raw === 'number' ? hit.raw : null;
  }

  const rate = valueAt(config.byId(indicator.inputs[0]), year);
  const popPrev = valueAt(config.byId(indicator.inputs[1]), String(Number(year) - 1));
  const popNow = valueAt(config.byId(indicator.inputs[1]), year);

  if (indicator.derive === 'rate_count') {
    if (rate === null || popPrev === null || popNow === null) return null;
    return clean((rate / 1000) * ((popPrev + popNow) / 2));
  }
  return null;
}

function latestComputedYear(indicator) {
  for (let y = Number(policy.expectedLatestYear(new Date())); y >= Number(config.historyRange().from); y -= 1) {
    if (valueAt(indicator, String(y)) !== null) return String(y);
  }
  return '';
}

/** 计算量的 stale 跟着输入指标走 */
function inputsStale(indicator) {
  return (indicator.inputs || []).some((id) => {
    const dep = config.byId(id);
    if (!dep) return true;
    if (dep.derive) return inputsStale(dep);
    const years = store.listYears(dep.id);
    const latest = years.length ? years[years.length - 1] : '';
    const meta = store.readMeta(dep.id) || {};
    return !latest || latest < capOf(dep) || !!meta.lastError;
  });
}

/** 栏目下所有原值指标成员（用于批量取数；计算量没有栏目） */
function membersOfCatalog(catalogKey) {
  const out = [];
  config.list().forEach((indicator) => {
    if (!indicator.derive && indicator.catalog === catalogKey) out.push(indicator);
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
      // 只给「最新有效年份之前」的空洞落 null 占位：教育栏目 2000 年前的年度、
      // 人口分段早期缺口这类官方本来就没有的年份，不落盘会被 policy 当成
      // 「还没缓存」，每次打开都对同一份数据反复回源。
      // 最新有效年份之后的缺口不落占位：那通常是「还没发布」，落了会把
      // 「待更新」伪装成「已核对」
      const valueYears = Object.keys(map).filter((y) => y >= from && y <= to).sort();
      if (valueYears.length) {
        const lastWithValue = valueYears[valueYears.length - 1];
        const cachedYears = new Set(store.listYears(m.id));
        for (let y = Number(from); y <= Number(lastWithValue); y += 1) {
          const k = String(y);
          if (cachedYears.has(k) || Object.prototype.hasOwnProperty.call(map, k)) continue;
          store.writeYear(m.id, k, { raw: null, source: 'nbs', fetchedAt });
        }
      }
      const meta = store.readMeta(m.id) || {};
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
  const cap = capOf(indicator);
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < cap ? o.to : cap;
  if (from > to) return { fetched: false, reason: '区间为空' };

  const cached = store.listYears(indicator.id);
  const decision = policy.shouldFetch({
    cachedYears: cached.filter((y) => y >= from && y <= to),
    wantFrom: from,
    until: indicator.until,
    force: o.force,
  });

  if (!decision.fetch) return { fetched: false, reason: decision.reason };

  const prevMeta = store.readMeta(indicator.id) || {};

  if (!o.force && prevMeta.lastAttempt && Date.now() - Date.parse(prevMeta.lastAttempt) < policy.TRY_INTERVAL_MS) {
    return { fetched: false, reason: '距上次回源不足 ' + Math.round(policy.TRY_INTERVAL_MS / 60000) + ' 分钟' };
  }

  if (blocked('ind:' + indicator.id, policy.COOLDOWN_MS)) {
    return { fetched: false, reason: '冷却中：同一指标 60 秒内不重复请求' };
  }

  if (o.dryRun) return { fetched: false, pending: true, reason: decision.reason };

  mark('ind:' + indicator.id);
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

/** 从缓存拼序列：缺年用 null，不插值；计算量逐年在 valueAt 里现算 */
function points(indicator, from, to) {
  return yearRange(from, to).map((year) => {
    const raw = valueAt(indicator, year);
    return {
      year: year,
      raw: raw,
      value: toValue(indicator, raw),
      source: raw === null ? null : indicator.derive ? 'computed' : 'nbs',
    };
  });
}

function descriptor(indicator) {
  const history = config.historyRange();
  const cap = capOf(indicator);
  const cached = indicator.derive ? [] : store.listYears(indicator.id).filter((y) => y <= cap);
  const meta = indicator.derive ? {} : store.readMeta(indicator.id) || {};
  const latestCached = indicator.derive
    ? latestComputedYear(indicator)
    : cached.length
      ? cached[cached.length - 1]
      : '';
  const stale = indicator.derive
    ? inputsStale(indicator)
    : !latestCached || latestCached < cap || !!meta.lastError;
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
    expectedLatest: cap,
    latestCached: latestCached,
    stale: stale,
    computed: !!indicator.derive,
    source: indicator.derive ? (latestCached ? 'computed' : '') : meta.lastSource || (cached.length ? 'nbs' : ''),
    lastError: meta.lastError || '',
    lastSuccess: meta.lastSuccess || '',
  };
}

/** 单指标：先 ensure 再取数 */
async function getSeries(id, opts) {
  const o = opts || {};
  const indicator = config.byId(id);
  const history = config.historyRange();
  const cap = capOf(indicator);
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < cap ? o.to : cap;

  const ensureResult = indicator.derive
    ? { fetched: false, reason: '本页计算值，不回源' }
    : await ensure(indicator, { from: from, to: to, force: o.force });
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

/** 后台补拉（stale-while-revalidate）：同一区间只跑一份 */
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

/** 原值拼成 model 需要的 { 指标id: { 年份: 数值 } } */
function rawMap() {
  const out = {};
  config.list().forEach((indicator) => {
    if (indicator.derive) return;
    const years = store.listYears(indicator.id);
    const map = {};
    years.forEach((year) => {
      const hit = store.readYear(indicator.id, year);
      if (hit && typeof hit.raw === 'number') map[year] = hit.raw;
    });
    out[indicator.id] = map;
  });
  return out;
}

/** 全量（前端一次请求拿到历史 + 推演） */
async function overview(opts) {
  const o = opts || {};
  const history = config.historyRange();
  const indicators = config.list();
  const fetchable = indicators.filter((ind) => !ind.derive);
  const chartFrom = o.chartFrom || '2000';

  const startedAt = Date.now();
  let fetchedCount = 0;
  const errors = [];

  // 与民生模块同款四分类：cold 首次拉全、empty 区间空、behind 落后两年、warm 基本跟上
  const warm = [];
  const empty = [];
  const behind = [];
  const cold = [];
  indicators.forEach((ind) => {
    if (ind.derive) return;
    const years = store.listYears(ind.id);
    const cap = capOf(ind);
    const behindCutoff = String(Number(cap) - 2);
    if (!years.length) cold.push(ind);
    else if (!years.some((y) => y >= chartFrom && y <= cap)) empty.push(ind);
    else if (years[years.length - 1] < behindCutoff) behind.push(ind);
    else warm.push(ind);
  });

  for (const indicator of o.force ? fetchable : cold.concat(empty, behind)) {
    const bootstrap = cold.indexOf(indicator) !== -1 && !o.force;
    const r = await ensure(indicator, {
      from: bootstrap ? history.from : chartFrom,
      to: bootstrap ? expectedLatestOf() : capOf(indicator),
      force: o.force,
    });
    if (r.fetched) fetchedCount += 1;
    if (r.errors && r.errors.length) errors.push(indicator.id + ': ' + r.errors[0]);
  }

  const items = indicators.map((indicator) => {
    const pts = points(indicator, chartFrom, capOf(indicator));
    const desc = descriptor(indicator);
    const valid = pts.filter((x) => x.value !== null);
    return Object.assign({}, desc, {
      points: pts,
      latest: valid.length ? valid[valid.length - 1] : null,
      prev: valid.length > 1 ? valid[valid.length - 2] : null,
    });
  });

  let refreshing = 0;
  if (!o.force) {
    for (const indicator of warm) {
      const probe = await ensure(indicator, { from: chartFrom, to: capOf(indicator), force: false, dryRun: true });
      if (probe.pending) refreshing += 1;
    }
    if (refreshing) refreshInBackground(warm, chartFrom, expectedLatestOf());
    else if (bgJobs.has(chartFrom + '|' + expectedLatestOf())) refreshing = warm.length || 1;
  }

  const projection = model.build(rawMap(), { from: history.from, chartFrom: chartFrom });

  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    fetched: fetchedCount,
    refreshing: refreshing,
    errors: errors,
    stale: items.some((x) => x.stale),
    groups: config.settings().groups,
    history: history,
    indicators: items,
    model: projection,
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
    if (indicator.derive) return;
    const years = store.listYears(indicator.id);
    const last = years.length ? years[years.length - 1] : '';
    const cap = capOf(indicator);
    if (!last || last < cap) behind += 1;
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

module.exports = { ensure, points, descriptor, getSeries, overview, datasetStatus, toValue, yearRange, rawMap };
