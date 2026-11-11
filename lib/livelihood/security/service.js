'use strict';

/**
 * 养老医保序列服务：缓存优先——首次运行把 1990 年以来的社会保险各表一次拉全
 * （九个栏目、九次上游请求），之后每次打开只核对应发布年度，缺哪一年补哪一年。
 *
 * 落盘的只有上游原值（亿元 / 万人），下面这些量都是现算的：
 *   当期结余 = 基金收入 − 基金支出
 *   人均养老金支出 = 基金支出（亿元）× 1e8 ÷（领取人数（万人）× 1e4）
 *   基金可支付月数 = 累计结余 ÷（当年支出 ÷ 12）
 *   参保率 = 参保人数 ÷ 官方发布的分母 × 100
 * 公式改了不用清缓存；把计算值落盘反而会让口径改动后新旧数据混在一起。
 *
 * 四分类（与宏观 / 婚育 / 收支 / 存款 / 社零 / 就业同款语义）：
 *   cold   一个栏目文件都没有：首次运行，整段拉全再渲染
 *   behind 最新缓存年度落后应发布年度 3 年以上（包放很久才打开）：同步补齐再渲染
 *   warm   基本跟上：先用缓存出图，只在「应发布年度还没落缓存」时后台核对
 * 上游失败一律回退缓存并标 stale，绝不返回空数组、绝不插值补 0。
 *
 * 已停更的序列（生育保险基金三项止于 2018）按 until 归档：画到截止年为止，
 * 不标 stale、不再回源。计算量的有效期跟着输入指标走（取最早的截止点）。
 */

const config = require('./config');
const store = require('./store');
const policy = require('./policy');
// 取数复用父目录的年度库通道（同一个站点、同一个年度库 rootId），限流也在里面
const source = require('../source');
const { blocked, mark } = require('../queue');

const HISTORY_YEARS_CAP = 300;

function decimalsOf(indicator) {
  return typeof indicator.decimals === 'number' ? indicator.decimals : 1;
}

/** 原值 → 展示值（定点取整） */
function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  const f = Math.pow(10, decimalsOf(indicator));
  return Math.round(raw * f) / f;
}

/** 计算量的浮点噪声（如 0.1 + 0.2 之类）裁到 4 位小数再交给 toValue */
function clean(x) {
  return Math.round(x * 10000) / 10000;
}

function nowYear() {
  return policy.currentYear(new Date());
}

/**
 * 全部栏目中最晚的应发布年度。各栏目 releaseMonth 相同，取最大值即可；
 * 停更归档的指标（until）不参与，否则生育保险会把整体拖回 2018。
 */
function expectedLatestYear(now) {
  const ref = now || new Date();
  let out = '';
  config.catalogs().forEach((cat) => {
    const e = policy.expectedYear(cat, ref);
    if (e > out) out = e;
  });
  return out || nowYear();
}

/** 指标所属栏目：计算量没有自己的 catalog，沿用第一个带 catalog 的输入指标 */
function catalogOfIndicator(indicator, depth) {
  if (indicator.catalog) return config.catalogOf(indicator.catalog);
  if ((depth || 0) > 4) return null;
  const inputs = indicator.inputs || [];
  for (let i = 0; i < inputs.length; i += 1) {
    const dep = config.byId(inputs[i]);
    if (!dep) continue;
    const cat = catalogOfIndicator(dep, (depth || 0) + 1);
    if (cat) return cat;
  }
  return null;
}

/**
 * 指标画到哪一年为止
 *   原值：until（归档）或所属栏目的应发布年度
 *   计算量：各输入指标里最早的截止点（生育当期结余跟着 2018 年一起停）
 */
function horizonOf(indicator, memo) {
  const m = memo || new Map();
  if (m.has(indicator.id)) return m.get(indicator.id);
  m.set(indicator.id, ''); // 防环，配置校验已挡掉自引用
  let horizon;
  if (indicator.until) {
    horizon = indicator.until;
  } else if (indicator.derive) {
    horizon = '';
    (indicator.inputs || []).forEach((id) => {
      const dep = config.byId(id);
      if (!dep) return;
      const h = horizonOf(dep, m);
      if (!h) return;
      if (!horizon || h < horizon) horizon = h;
    });
  } else {
    const cat = catalogOfIndicator(indicator);
    horizon = policy.expectedFor(indicator, cat, new Date());
  }
  m.set(indicator.id, horizon);
  return horizon;
}

/** 指标画到哪一年起（历史起点 / 栏目起点 / 指标自己的起点，取最晚的一个） */
function startFromOf(indicator, memo) {
  const m = memo || new Map();
  if (m.has(indicator.id)) return m.get(indicator.id);
  const history = config.historyRange();
  let from = history.from;
  m.set(indicator.id, from); // 防环
  if (indicator.derive) {
    (indicator.inputs || []).forEach((id) => {
      const dep = config.byId(id);
      const f = dep ? startFromOf(dep, m) : '';
      if (f > from) from = f;
    });
  } else {
    const cat = indicator.catalog ? config.catalogOf(indicator.catalog) : null;
    if (cat && cat.from && cat.from > from) from = cat.from;
  }
  if (indicator.from && indicator.from > from) from = indicator.from;
  m.set(indicator.id, from);
  return from;
}

/** 栏目缓存里最新的年度 */
function latestOf(cached) {
  if (!cached || !cached.series) return '';
  let latest = '';
  Object.keys(cached.series).forEach((iid) => {
    const map = cached.series[iid] || {};
    Object.keys(map).forEach((p) => {
      if (p > latest) latest = p;
    });
  });
  return latest;
}

/** 单个指标在栏目缓存里最新的年度 */
function latestYearOfSeries(cached, indicatorId) {
  const map = (cached && cached.series && cached.series[indicatorId]) || {};
  let latest = '';
  Object.keys(map).forEach((p) => {
    if (p > latest) latest = p;
  });
  return latest;
}

/**
 * 栏目还缺几年。按「每个非归档指标各自最新的年份」判断，不看栏目内最大值：
 * 基金合计已到 2025、各险种仍停 2024 时，最大值会把这个栏目当成够新，缺项就再也补不上了。
 */
function lagOfCatalog(cat, cached, now) {
  const ref = now || new Date();
  let lag = 0;
  config.indicatorsOfCatalog(cat.id).forEach((ind) => {
    if (!ind.indicatorId || ind.until) return; // 归档序列不回源
    const one = policy.gapOf(latestYearOfSeries(cached, ind.indicatorId), policy.expectedFor(ind, cat, ref));
    if (one > lag) lag = one;
  });
  return lag;
}

/** 归档序列（until）缓存到截止年就不再多取，手动刷新也不例外 */
function archivedCovered(cat, cached, indicatorId) {
  const ind = config.indicatorsOfCatalog(cat.id).find((x) => x.indicatorId === indicatorId);
  if (!ind || !ind.until) return false;
  return latestYearOfSeries(cached, indicatorId) >= ind.until;
}

/** 需要从上游取的指标 id（计算量不取） */
function fetchIdsOf(cat) {
  return config
    .indicatorsOfCatalog(cat.id)
    .filter((ind) => ind.indicatorId)
    .map((ind) => ind.indicatorId);
}

/**
 * 补一个栏目（失败只记录，不抛错）
 * @param {object} cat 栏目配置
 * @param {{force?:boolean, dryRun?:boolean}} opts
 */
async function ensureCatalog(cat, opts) {
  const o = opts || {};
  const res = { key: cat.id, fetched: 0, pending: 0, error: '' };
  const cached = store.readCatalog(cat.id);
  const required = policy.requiredFor(cat, config.indicatorsOfCatalog(cat.id), new Date());

  // 已经够新就不回源（逐个指标判，归档序列不参与）；用户手动刷新（force）例外，真去上游核一遍
  if (!o.force && cached && lagOfCatalog(cat, cached) === 0) return res;

  const meta = store.readMeta();
  meta.catalogs = meta.catalogs || {};
  const cMeta = meta.catalogs[cat.id] || {};
  // 距上次回源不足 10 分钟：直接用缓存（落盘，进程重启后仍生效）
  if (!o.force && cMeta.lastAttempt && Date.now() - Date.parse(cMeta.lastAttempt) < policy.TRY_INTERVAL_MS) {
    return res;
  }
  if (o.dryRun) {
    res.pending = 1;
    return res;
  }
  if (blocked('security:' + cat.id, policy.COOLDOWN_MS)) return res;

  const history = config.historyRange();
  const base = cat.from && cat.from > history.from ? cat.from : history.from;
  const to = cat.to && cat.to < required ? cat.to : required;
  if (to < base) return res; // 上游这一期还没开始发布

  // 归档序列已经缓存到截止年就不再带上去查（force 也不查）
  const ids = fetchIdsOf(cat).filter((iid) => !archivedCovered(cat, cached, iid));
  if (!ids.length) return res;

  mark('security:' + cat.id);
  meta.catalogs[cat.id] = Object.assign({}, cMeta, { lastAttempt: new Date().toISOString() });
  store.writeMeta(meta);

  try {
    const got = await source.fetchRange({ catalogId: cat.catalogId, indicatorIds: ids, from: base, to: to });
    // 合并而不是覆盖：补新年份时别把已有年份冲掉，同年份以上游新值为准。
    // 落盘前重读一次，避免与并发刷新拿着同一份旧快照互相覆盖
    const fresh = store.readCatalog(cat.id) || cached;
    const prev = (fresh && fresh.series) || {};
    const series = Object.assign({}, prev);
    Object.keys(got).forEach((iid) => {
      series[iid] = Object.assign({}, prev[iid] || {}, got[iid]);
    });
    store.writeCatalog(cat.id, {
      catalogId: cat.catalogId,
      series: series,
      from: (cached && cached.from) || base,
      to: to,
      fetchedAt: new Date().toISOString(),
    });
    res.fetched = 1;

    const after = store.readMeta();
    after.catalogs = after.catalogs || {};
    after.catalogs[cat.id] = Object.assign({}, after.catalogs[cat.id] || {}, {
      lastSuccess: new Date().toISOString(),
      lastError: null,
      latest: latestOf(store.readCatalog(cat.id)),
    });
    store.writeMeta(after);
  } catch (e) {
    const after = store.readMeta();
    after.catalogs = after.catalogs || {};
    after.catalogs[cat.id] = Object.assign({}, after.catalogs[cat.id] || {}, { lastError: e.message });
    store.writeMeta(after);
    res.error = cat.label + '：' + e.message;
  }

  return res;
}

/** 把所有栏目核一遍（串行，限流在父目录 source 里） */
async function ensureAll(opts) {
  const o = opts || {};
  const out = { fetched: 0, errors: [], pending: 0 };
  let fails = 0;
  for (const cat of config.catalogs()) {
    const one = await ensureCatalog(cat, o);
    out.fetched += one.fetched;
    out.pending += one.pending;
    if (one.error) {
      out.errors.push(one.error);
      fails += 1;
      // 连续三个栏目都拿不到：上游整体不可用，剩下的不再一个个试，直接用缓存
      if (fails >= 3) {
        out.errors.push('连续 ' + fails + ' 个栏目回源失败，本次不再继续尝试');
        break;
      }
    } else {
      fails = 0;
    }
  }
  return out;
}

/* ---------------- 从缓存拼序列 ---------------- */

/** 一次请求内只读一遍全部栏目文件：'栏目|指标id' → { 年份: 值 } */
function makeIndex() {
  const map = new Map();
  config.catalogs().forEach((cat) => {
    const one = store.readCatalog(cat.id);
    const series = (one && one.series) || {};
    Object.keys(series).forEach((iid) => map.set(cat.id + '|' + iid, series[iid] || {}));
  });
  return map;
}

function rawAt(index, catalog, indicatorId, period) {
  const m = index.get(catalog + '|' + indicatorId);
  const v = m ? m[period] : undefined;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 指标在某个年份的值：原值直取，计算量现算（缺任一项就是缺失，不补 0） */
function valueAt(id, period, index) {
  const ind = config.byId(id);
  if (!ind.derive) return rawAt(index, ind.catalog, ind.indicatorId, period);

  const a = valueAt(ind.inputs[0], period, index);
  const b = valueAt(ind.inputs[1], period, index);
  if (a === null || b === null) return null;

  if (ind.derive === 'diff') return clean(a - b);
  if (ind.derive === 'ratio_pct') return b === 0 ? null : clean((a / b) * 100);
  if (ind.derive === 'months') return b === 0 ? null : clean(a / (b / 12));
  if (ind.derive === 'per_capita') return b === 0 ? null : clean((a * 1e8) / (b * 1e4));
  return null;
}

function makeContext() {
  return {
    index: makeIndex(),
    stats: store.stats(),
    expectedYear: nowYear(),
    history: config.historyRange(),
    horizonMemo: new Map(),
    fromMemo: new Map(),
    staleMemo: new Map(),
    failed: null,
  };
}

/** 指标要画的年度区间：年度指标按请求区间，缺省画到应发布年度 */
function seriesRange(indicator, req, ctx) {
  const c = ctx || makeContext();
  const from0 = startFromOf(indicator, c.fromMemo);
  const horizon = horizonOf(indicator, c.horizonMemo);
  const from = req && req.from && req.from > from0 ? req.from : from0;
  const to = req && req.to && req.to < horizon ? req.to : horizon;
  return { from: from, to: to };
}

/** 从缓存拼序列：缺年为 null，不插值 */
function points(indicator, range, ctx) {
  const c = ctx || makeContext();
  const periods = policy.yearSpan(range.from, range.to).slice(0, HISTORY_YEARS_CAP);
  return periods.map((period) => {
    const raw = valueAt(indicator.id, period, c.index);
    return {
      period: period,
      raw: raw,
      value: toValue(indicator, raw),
      source: raw === null ? null : indicator.derive ? 'computed' : 'nbs',
    };
  });
}

/** 该指标最新一个「有值」的年度 */
function latestOfIndicator(indicator, ctx) {
  const c = ctx || makeContext();
  const range = seriesRange(indicator, null, c);
  const periods = policy.yearSpan(range.from, range.to);
  for (let i = periods.length - 1; i >= 0; i -= 1) {
    if (valueAt(indicator.id, periods[i], c.index) !== null) return periods[i];
  }
  return '';
}

/** 最近一次回源错误（按栏目） */
function lastErrorOf() {
  const meta = store.readMeta();
  const out = [];
  config.catalogs().forEach((cat) => {
    const one = (meta.catalogs || {})[cat.id] || {};
    if (one.lastError) out.push(cat.label + '：' + one.lastError);
  });
  return out;
}

/** 最近一次回源失败的栏目（一次请求内只读一遍 _meta.json） */
function failedCatalogs(c) {
  if (!c.failed) {
    const meta = store.readMeta();
    c.failed = new Set(
      config
        .catalogs()
        .filter((cat) => !!((meta.catalogs || {})[cat.id] || {}).lastError)
        .map((cat) => cat.id)
    );
  }
  return c.failed;
}

/** 指标是否滞后：计算量跟着输入指标走，归档序列永远不算滞后 */
function staleOf(indicator, ctx) {
  const c = ctx || makeContext();
  if (c.staleMemo.has(indicator.id)) return c.staleMemo.get(indicator.id);
  c.staleMemo.set(indicator.id, false); // 防环
  let stale;
  if (indicator.until) {
    stale = false;
  } else if (indicator.derive) {
    stale = (indicator.inputs || []).some((id) => {
      const dep = config.byId(id);
      return dep ? staleOf(dep, c) : true;
    });
  } else {
    const cat = catalogOfIndicator(indicator);
    const expected = policy.expectedFor(indicator, cat, new Date());
    // 上游刚失败过：数字回退自缓存，年份再新也要让前端看见 stale
    const failed = !!cat && failedCatalogs(c).has(cat.id);
    stale = failed || policy.isStale(latestOfIndicator(indicator, c), expected);
  }
  c.staleMemo.set(indicator.id, stale);
  return stale;
}

function descriptor(indicator, ctx) {
  const c = ctx || makeContext();
  const history = config.historyRange();
  const cat = catalogOfIndicator(indicator);
  const horizon = horizonOf(indicator, c.horizonMemo);
  // 计算量跟着输入指标归档：生育当期结余止于 2018，也算归档而不是「滞后」
  const archived = !!indicator.until || (!!indicator.derive && !!horizon && horizon < expectedLatestYear());
  const expected = archived ? '' : horizon;
  const latest = latestOfIndicator(indicator, c);
  const meta = store.readMeta();
  const catMeta = cat ? (meta.catalogs || {})[cat.id] || {} : {};

  return {
    id: indicator.id,
    label: indicator.label,
    shortLabel: indicator.shortLabel || indicator.label,
    unit: indicator.unit,
    kind: indicator.kind,
    freq: 'year',
    group: indicator.group || '',
    decimals: decimalsOf(indicator),
    note: indicator.note || '',
    historyFrom: startFromOf(indicator, c.fromMemo),
    until: indicator.until || '',
    expectedLatest: expected,
    latestCached: latest,
    stale: staleOf(indicator, c),
    archived: archived,
    source: latest ? 'nbs' : '',
    lastSuccess: catMeta.lastSuccess || '',
    // 计算口径：前端图注直接显示，避免把计算值当成官方发布值
    computed: !!indicator.derive,
  };
}

/** 只读缓存的指标清单：一次读盘，供 /indicators 用 */
function describeAll() {
  const ctx = makeContext();
  return config.list().map((ind) => descriptor(ind, ctx));
}

/** 单指标：先 ensure 再取数 */
async function getSeries(id, opts) {
  const o = opts || {};
  const indicator = config.byId(id);
  const before = makeContext();
  // 归档序列（until）缓存到截止年就直接读，手动刷新也不回源
  const archivedReady = !!indicator.until && latestOfIndicator(indicator, before) >= indicator.until;
  const r = archivedReady ? { fetched: 0, errors: [] } : await ensureAll({ force: o.force });
  const ctx = archivedReady ? before : makeContext();
  const range = seriesRange(indicator, { from: o.from, to: o.to }, ctx);
  const pts = points(indicator, range, ctx);
  const desc = descriptor(indicator, ctx);
  const valid = pts.filter((x) => x.value !== null);
  return Object.assign({}, desc, {
    from: range.from,
    to: range.to,
    points: pts,
    latest: valid.length ? valid[valid.length - 1] : null,
    prev: valid.length > 1 ? valid[valid.length - 2] : null,
    fetched: r.fetched > 0,
    fetchReason: r.errors && r.errors.length ? r.errors[0] : '',
  });
}

/** 后台补拉：同一时刻只跑一份，不重复堆任务 */
const bgJobs = new Map();

function refreshInBackground() {
  const key = 'all';
  if (bgJobs.has(key)) return;
  const job = (async () => {
    await ensureAll({ force: false });
  })();
  bgJobs.set(
    key,
    job.then(
      () => jobsDone(key),
      () => jobsDone(key)
    )
  );
}

function jobsDone(key) {
  bgJobs.delete(key);
}

/** 落后几年：所有栏目里最大的缺口，用于决定要不要同步补齐 */
function maxLagOf() {
  let lag = 0;
  config.catalogs().forEach((cat) => {
    const one = lagOfCatalog(cat, store.readCatalog(cat.id));
    if (one > lag) lag = one;
  });
  return lag;
}

/**
 * 全量：前端一次请求拿到全部图的数据
 * @param {{from?:string, to?:string, force?:boolean}} opts from/to 为 'YYYY'
 */
async function overview(opts) {
  const o = opts || {};
  const history = config.historyRange();
  const base = expectedLatestYear();
  const req = { from: o.from || history.from, to: o.to || base };
  const startedAt = Date.now();

  const before = store.stats();
  const cold = !before.catalogs;

  // 首次运行整段拉全；落后 3 年以上同步补齐；其余交给后台
  const sync = cold || maxLagOf() >= 3;
  let fetched = 0;
  let errors = [];
  if (cold || o.force || sync) {
    const r = await ensureAll({ force: o.force });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  }

  const ctx = makeContext();
  const afterLag = maxLagOf();

  const items = config.list().map((indicator) => {
    const desc = descriptor(indicator, ctx);
    const range = seriesRange(indicator, req, ctx);
    const pts = points(indicator, range, ctx);
    const valid = pts.filter((x) => x.value !== null);
    return Object.assign({}, desc, {
      from: range.from,
      to: range.to,
      points: pts,
      latest: valid.length ? valid[valid.length - 1] : null,
      prev: valid.length > 1 ? valid[valid.length - 2] : null,
    });
  });

  // 后台核对：只有落后应发布年度时才发起，首屏不等它
  let refreshing = 0;
  if (!o.force && !cold && afterLag > 0) {
    const probe = await ensureAll({ dryRun: true });
    if (probe.pending) {
      refreshing = probe.pending;
      refreshInBackground();
    } else if (bgJobs.size) {
      refreshing = bgJobs.size;
    }
  }

  const settings = config.settings();
  const expectedYears = {};
  config.catalogs().forEach((cat) => {
    expectedYears[cat.id] = policy.expectedYear(cat, new Date());
  });

  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range: { from: req.from, to: req.to },
    history: { from: history.from, note: history.note },
    expectedYear: base,
    // 与其它年度模块同名，前端模板可直接复用
    expectedLatest: base,
    expectedYears: expectedYears,
    latestYear: ctx.stats.latestYear,
    fetched: fetched,
    refreshing: refreshing,
    errors: errors.concat(lastErrorOf()),
    stale: items.some((x) => x.stale),
    groups: settings.groups,
    source: settings.source,
    indicators: items,
    firstRun: cold,
    cache: ctx.stats,
  };
}

/** 数据集概况：只读本地文件，不回源，供启动日志与健康检查使用 */
function datasetStatus() {
  const stats = store.stats();
  const ctx = makeContext();
  // 按指标而不是按全局最新年判断：合计类已到 2025、各险种还停 2024 是常态
  const stale = config.list().filter((ind) => staleOf(ind, ctx)).length;
  return {
    dir: stats.dir,
    catalogs: stats.catalogs,
    series: stats.series,
    points: stats.points,
    years: stats.years,
    historyFrom: config.historyRange().from,
    latestYear: stats.latestYear,
    expectedYear: expectedLatestYear(),
    stale: stale,
    behind: stale > 0,
  };
}

module.exports = {
  ensureAll,
  ensureCatalog,
  points,
  seriesRange,
  descriptor,
  describeAll,
  getSeries,
  overview,
  datasetStatus,
  toValue,
  valueAt,
  horizonOf,
  startFromOf,
  expectedYear: expectedLatestYear,
  expectedLatestYear,
  latestOfIndicator,
};
