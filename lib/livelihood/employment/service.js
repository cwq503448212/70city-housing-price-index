'use strict';

/**
 * 就业序列服务：缓存优先——首次运行把 2018 年以来的月度失业率与工时、
 * 1978 年以来的年度农民工与登记失业一次拉全（三个栏目、三次上游请求），
 * 之后每次打开只核对应发布期别，缺哪一期补哪一期。
 *
 * 落盘的只有上游原值（% / 小时 / 万人 / 元），下面这些量都是现算的：
 *   31 城与全国差 = 31 个大城市失业率 − 全国失业率
 *   青年与全国差 = 16—24 岁失业率 − 全国失业率
 *   外出农民工占比 = 外出农民工 ÷ 农民工总量
 * 公式改了不用清缓存；把计算值落盘反而会让口径改动后新旧数据混在一起。
 *
 * 四分类（与宏观 / 婚育 / 收支 / 存款 / 社零同款语义）：
 *   cold   一个栏目文件都没有：首次运行，整段拉全再渲染
 *   behind 最新缓存期别落后应发布期别 3 期以上（包放半年才打开）：同步补齐再渲染
 *   warm   基本跟上：先用缓存出图，只在「应发布期别还没落缓存」时后台核对
 * 上游失败一律回退缓存并标 stale，绝不返回空数组、绝不插值补 0。
 *
 * 已停更的序列（25—59 岁旧口径止于 2023-06、登记失业率止于 2021）按 until 归档：
 * 序列画到截止期为止，不标 stale、不再回源。
 */

const config = require('./config');
const store = require('./store');
const policy = require('./policy');
const source = require('./source');
const { blocked, mark } = require('../queue');

function decimalsOf(indicator) {
  return typeof indicator.decimals === 'number' ? indicator.decimals : 1;
}

/** 原值 → 展示值（定点取整） */
function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  const f = Math.pow(10, decimalsOf(indicator));
  return Math.round(raw * f) / f;
}

/** 计算量的浮点噪声（5.3 − 5.1 之类）裁到 4 位小数再交给 toValue */
function clean(x) {
  return Math.round(x * 10000) / 10000;
}

function nowMonth() {
  return policy.expectedMonth(new Date());
}

function expectedYearOf(cat) {
  return policy.expectedYear(cat, new Date());
}

/** 指标所属栏目：计算量没有自己的 catalog，沿用第一个输入指标的栏目 */
function catalogOfIndicator(indicator) {
  if (indicator.catalog) return config.catalogOf(indicator.catalog);
  const dep = config.byId((indicator.inputs || [])[0]);
  return dep && dep.catalog ? config.catalogOf(dep.catalog) : null;
}

/** 指标画到哪一期为止（归档序列截在 until） */
function horizonOf(indicator) {
  if (indicator.freq === 'year') {
    const cat = catalogOfIndicator(indicator);
    const e = cat ? expectedYearOf(cat) : '';
    return indicator.until && e && indicator.until < e ? indicator.until : e || indicator.until || '';
  }
  const e = nowMonth();
  return indicator.until && indicator.until < e ? indicator.until : e;
}

/** 栏目缓存里最新的期别 */
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

/** 需要从上游取的指标 id（计算量不取） */
function fetchIdsOf(cat) {
  return config
    .indicatorsOfCatalog(cat.id)
    .filter((ind) => !ind.derive && ind.indicatorId)
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

  // 已经够新就不回源；用户手动刷新（force）例外，真去上游核一遍
  if (!o.force && cached && latestOf(cached) >= required) return res;

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
  if (blocked('employment:' + cat.id, policy.COOLDOWN_MS)) return res;

  const history = config.historyRange();
  const base = cat.freq === 'year' ? history.year : history.month;
  const from = cat.from && cat.from > base ? cat.from : base;
  const to = cat.to && cat.to < required ? cat.to : required;
  if (to < from) return res; // 上游这一期还没开始发布

  const ids = fetchIdsOf(cat);
  if (!ids.length) return res;

  mark('employment:' + cat.id);
  meta.catalogs[cat.id] = Object.assign({}, cMeta, { lastAttempt: new Date().toISOString() });
  store.writeMeta(meta);

  try {
    const got = await source.fetchCatalog({
      freq: cat.freq,
      catalogId: cat.catalogId,
      indicatorIds: ids,
      from: from,
      to: to,
    });
    // 合并而不是覆盖：补最新一期时别把已有月份冲掉，同期别以上游新值为准
    const prev = (cached && cached.series) || {};
    const series = Object.assign({}, prev);
    Object.keys(got.series).forEach((iid) => {
      series[iid] = Object.assign({}, prev[iid] || {}, got.series[iid]);
    });
    store.writeCatalog(cat.id, {
      freq: cat.freq,
      catalogId: cat.catalogId,
      series: series,
      from: (cached && cached.from) || from,
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

/** 把所有栏目核一遍（串行，限流在 source 里） */
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

/** 一次请求内只读一遍全部栏目文件：'栏目|指标id' → { 期别: 值 } */
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

/** 指标在某个期别的值：原值直取，计算量现算 */
function valueAt(id, period, index) {
  const ind = config.byId(id);
  if (!ind.derive) return rawAt(index, ind.catalog, ind.indicatorId, period);

  if (ind.derive === 'gap_city') {
    const city = valueAt('unemployment_city31', period, index);
    const all = valueAt('unemployment', period, index);
    return city === null || all === null ? null : clean(city - all);
  }
  if (ind.derive === 'gap_youth') {
    const youth = valueAt('youth_unemployment', period, index);
    const all = valueAt('unemployment', period, index);
    return youth === null || all === null ? null : clean(youth - all);
  }
  if (ind.derive === 'migrant_out_share') {
    const out = valueAt('migrant_out', period, index);
    const total = valueAt('migrant_total', period, index);
    if (out === null || total === null || total === 0) return null;
    return clean((out / total) * 100);
  }
  return null;
}

function makeContext() {
  const stats = store.stats();
  return {
    index: makeIndex(),
    stats: stats,
    expectedMonth: nowMonth(),
    history: config.historyRange(),
  };
}

/** 指标要画的期别区间：月度按请求区间，年度按栏目起点到应发布年度 */
function seriesRange(indicator, req) {
  const history = config.historyRange();
  const horizon = horizonOf(indicator);
  if (indicator.freq === 'year') {
    const cat = catalogOfIndicator(indicator);
    let from = (cat && cat.from) || history.year;
    // 计算量取各输入指标起点里最晚的一个
    (indicator.inputs || []).forEach((id) => {
      const dep = config.byId(id);
      const depCat = dep && dep.catalog ? config.catalogOf(dep.catalog) : null;
      if (depCat && depCat.from && depCat.from > from) from = depCat.from;
    });
    return { from: from, to: horizon };
  }
  const from0 = history.month;
  const from = req && req.from && req.from > from0 ? req.from : from0;
  const to = req && req.to && req.to < horizon ? req.to : horizon;
  return { from: from, to: to };
}

/** 从缓存拼序列：缺期为 null，不插值 */
function points(indicator, range, ctx) {
  const c = ctx || makeContext();
  const periods =
    indicator.freq === 'year'
      ? policy.yearSpan(range.from, range.to)
      : policy.monthSpan(range.from, range.to);
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

/** 该指标最新一个「有值」的期别 */
function latestOfIndicator(indicator, ctx) {
  const c = ctx || makeContext();
  const range = seriesRange(indicator, null);
  const periods =
    indicator.freq === 'year'
      ? policy.yearSpan(range.from, range.to)
      : policy.monthSpan(range.from, range.to);
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

function descriptor(indicator, ctx) {
  const c = ctx || makeContext();
  const history = config.historyRange();
  const cat = catalogOfIndicator(indicator);
  const archived = !!indicator.until;
  const expected = archived ? '' : policy.expectedFor(indicator, cat, new Date());
  const latest = latestOfIndicator(indicator, c);
  const meta = store.readMeta();
  const catMeta = cat ? (meta.catalogs || {})[cat.id] || {} : {};

  return {
    id: indicator.id,
    label: indicator.label,
    shortLabel: indicator.shortLabel || indicator.label,
    unit: indicator.unit,
    kind: indicator.kind,
    freq: indicator.freq,
    group: indicator.group || '',
    decimals: decimalsOf(indicator),
    note: indicator.note || '',
    historyFrom: indicator.freq === 'year' ? (cat && cat.from) || history.year : history.month,
    until: indicator.until || '',
    expectedLatest: expected,
    latestCached: latest,
    // 官方已停更的序列永远不算滞后
    stale: archived ? false : !latest || latest < expected,
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
  const range = seriesRange(indicator, { from: o.from, to: o.to });

  const r = await ensureAll({ force: o.force });
  const ctx = makeContext();
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
      () => bgJobs.delete(key),
      () => bgJobs.delete(key)
    )
  );
}

/** 落后程度：月度按期、年度按年取最大值，用于决定要不要同步补齐 */
function lagOf(stats) {
  const monthLag = policy.gapOf(stats.latestMonth, nowMonth(), 'month');
  let yearLag = 0;
  config.catalogs()
    .filter((cat) => cat.freq === 'year')
    .forEach((cat) => {
      const expected = expectedYearOf(cat);
      const lag = policy.gapOf(stats.latestYear, expected, 'year');
      if (lag > yearLag) yearLag = lag;
    });
  return Math.max(monthLag, yearLag);
}

/**
 * 全量：前端一次请求拿到全部图的数据
 * @param {{from?:string, to?:string, force?:boolean}} opts from/to 为 'YYYY-MM'（只作用于月度序列）
 */
async function overview(opts) {
  const o = opts || {};
  const history = config.historyRange();
  const base = nowMonth();
  const req = { from: o.from || history.month, to: o.to || base };
  const startedAt = Date.now();

  const before = store.stats();
  const cold = !before.catalogs;

  // 首次运行整段拉全；落后 3 期以上同步补齐；其余交给后台
  const sync = cold || lagOf(before) >= 3;
  let fetched = 0;
  let errors = [];
  if (cold || o.force || sync) {
    const r = await ensureAll({ force: o.force });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  }

  const ctx = makeContext();
  // 冷启动补拉后再算一次落后程度，决定要不要再排后台任务
  const afterLag = lagOf(ctx.stats);

  const items = config.list().map((indicator) => {
    const desc = descriptor(indicator, ctx);
    const range = seriesRange(indicator, req);
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

  // 后台核对：只有落后应发布期别时才发起，首屏不等它
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
  config.catalogs()
    .filter((cat) => cat.freq === 'year')
    .forEach((cat) => {
      expectedYears[cat.id] = expectedYearOf(cat);
    });

  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range: { from: req.from, to: req.to },
    history: { month: history.month, year: history.year, note: history.note },
    expectedMonth: base,
    // 与其它月度模块同名，前端模板可直接复用
    expectedLatest: base,
    latestMonth: ctx.stats.latestMonth,
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
  const month = nowMonth();
  const behind = lagOf(stats) > 0;
  return {
    dir: stats.dir,
    catalogs: stats.catalogs,
    series: stats.series,
    points: stats.points,
    months: stats.months,
    years: stats.years,
    historyMonth: config.historyRange().month,
    historyYear: config.historyRange().year,
    latestMonth: stats.latestMonth,
    expectedMonth: month,
    latestYear: stats.latestYear,
    behind: behind,
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
  expectedMonth: nowMonth,
  latestOfIndicator,
};
