'use strict';

/**
 * 社会消费品零售序列服务：缓存优先——首次运行按栏目把 2015 年以来的历史拉全，
 * 之后每次打开只核对应发布月份，缺哪一期补哪一期
 *
 * 落盘的只有上游原值（亿元 / %），下面这些量都是现算的：
 *   剔除汽车     = 社零总额当月 − 限额以上汽车类零售额当月
 *   剔除汽车同比 = 剔除汽车当月 ÷ 上年同月剔除值 − 1
 *   乡村占比     = 乡村当月 ÷ 社零总额当月
 *   网上占比     = （实物商品 / 网上商品）网上零售额累计 ÷ 社零总额累计
 * 公式改了不用清缓存；把计算值落盘反而会让口径改动后新旧数据混在一起。
 *
 * 四分类（与宏观 / 婚育 / 收支 / 存款同款语义）：
 *   cold   一个栏目文件都没有：首次运行，把 2015 到应发布月份整段拉全再渲染
 *   behind 最新缓存月落后应发布月份 3 期以上（包放了半年才打开）：同步补齐再渲染
 *   warm   基本跟上：先用缓存出图，只在「应发布月份还没落缓存」时后台核对
 * 上游失败一律回退缓存并标 stale，绝不返回空数组、绝不插值补 0。
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

/** 计算量的浮点噪声（42432.5 − 3640.8 之类）裁到 4 位小数再交给 toValue */
function clean(x) {
  return Math.round(x * 10000) / 10000;
}

function expectedBase() {
  return policy.expectedLatestMonth(new Date());
}

/** 栏目缓存里最新的月份 */
function latestOf(cached) {
  if (!cached || !cached.series) return '';
  let latest = '';
  Object.keys(cached.series).forEach((iid) => {
    const map = cached.series[iid] || {};
    Object.keys(map).forEach((m) => {
      if (m > latest) latest = m;
    });
  });
  return latest;
}

/** 某个栏目名下的指标 */
function indicatorsOfCatalog(key) {
  return config.list().filter((ind) => ind.catalog === key);
}

/** 该栏目名下指标里最晚的应发布月份（已扣掉 1、2 月合并公布） */
function requiredOf(cat) {
  const base = expectedBase();
  let need = '';
  indicatorsOfCatalog(cat.id).forEach((ind) => {
    const e = policy.expectedFor(ind, base);
    if (e > need) need = e;
  });
  return need || base;
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
  const required = requiredOf(cat);

  // 上游已停更的栏目（旧口径网上零售）：拉到过一次就不再回源
  if (cached && cat.frozen) return res;
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
  if (blocked('retail:' + cat.id, policy.COOLDOWN_MS)) return res;

  const history = config.historyRange();
  const from = cat.from && cat.from > history.from ? cat.from : history.from;
  const to = cat.to && cat.to < required ? cat.to : required;
  if (to < from) return res; // 上游这一期还没开始发布

  const ids = indicatorsOfCatalog(cat.id).map((ind) => ind.indicatorId);
  if (!ids.length) return res;

  mark('retail:' + cat.id);
  meta.catalogs[cat.id] = Object.assign({}, cMeta, { lastAttempt: new Date().toISOString() });
  store.writeMeta(meta);

  try {
    const got = await source.fetchCatalog({ catalogId: cat.catalogId, indicatorIds: ids, from: from, to: to });
    // 合并而不是覆盖：补最新一期时别把已有月份冲掉，同月份以上游新值为准
    const prev = (cached && cached.series) || {};
    const series = Object.assign({}, prev);
    Object.keys(got.series).forEach((iid) => {
      series[iid] = Object.assign({}, prev[iid] || {}, got.series[iid]);
    });
    store.writeCatalog(cat.id, {
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

/** 一次请求内只读一遍全部栏目文件：'栏目|指标id' → { 'YYYY-MM': 值 } */
function makeIndex() {
  const map = new Map();
  config.catalogs().forEach((cat) => {
    const one = store.readCatalog(cat.id);
    const series = (one && one.series) || {};
    Object.keys(series).forEach((iid) => map.set(cat.id + '|' + iid, series[iid] || {}));
  });
  return map;
}

function rawAt(index, catalog, indicatorId, month) {
  const m = index.get(catalog + '|' + indicatorId);
  const v = m ? m[month] : undefined;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 指标在某个统计月的值：原值直取，计算量现算 */
function valueAt(id, month, index) {
  const ind = config.byId(id);
  if (!ind.derive) return rawAt(index, ind.catalog, ind.indicatorId, month);

  if (ind.derive === 'ex_car') {
    const total = valueAt('total_amount', month, index);
    const car = valueAt('car_amount', month, index);
    return total === null || car === null ? null : clean(total - car);
  }
  if (ind.derive === 'ex_car_yoy') {
    const cur = valueAt('ex_car_amount', month, index);
    const prev = valueAt('ex_car_amount', policy.addMonths(month, -12), index);
    if (cur === null || prev === null || prev === 0) return null;
    return clean((cur / prev - 1) * 100);
  }
  if (ind.derive === 'online_share') {
    const total = valueAt('total_cum', month, index);
    if (total === null || total === 0) return null;
    // 2025-12 及以前用旧口径「实物商品网上零售额」，2026-02 起用新口径「网上商品零售额」
    let goods = valueAt('online_goods_cum', month, index);
    if (goods === null) goods = valueAt('online_goods_cum_new', month, index);
    if (goods === null) return null;
    return clean((goods / total) * 100);
  }
  if (ind.derive === 'rural_share') {
    const total = valueAt('total_amount', month, index);
    const rural = valueAt('rural_amount', month, index);
    if (total === null || total === 0 || rural === null) return null;
    return clean((rural / total) * 100);
  }
  return null;
}

function makeContext() {
  const stats = store.stats();
  const base = expectedBase();
  return {
    index: makeIndex(),
    base: base,
    stats: stats,
    horizon: base > stats.latest ? base : stats.latest,
  };
}

/** 从缓存拼序列：缺月为 null，不插值 */
function points(indicator, from, to, ctx) {
  const c = ctx || makeContext();
  return policy.monthSpan(from, to).map((month) => {
    const raw = valueAt(indicator.id, month, c.index);
    return {
      month: month,
      raw: raw,
      value: toValue(indicator, raw),
      source: raw === null ? null : indicator.derive ? 'computed' : 'nbs',
    };
  });
}

/** 该指标最新一个「有值」的月份 */
function latestMonthOf(indicator, ctx) {
  const c = ctx || makeContext();
  const history = config.historyRange();
  const cat = indicator.catalog ? config.catalogOf(indicator.catalog) : null;
  const archiveEnd = cat && cat.frozen && cat.to ? cat.to : '';
  let end = c.horizon;
  if (archiveEnd && archiveEnd < end) end = archiveEnd;
  if (end < history.from) end = history.from;
  const span = policy.monthSpan(history.from, end);
  for (let i = span.length - 1; i >= 0; i -= 1) {
    if (valueAt(indicator.id, span[i], c.index) !== null) return span[i];
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
  const cat = indicator.catalog ? config.catalogOf(indicator.catalog) : null;
  const archived = !!(cat && cat.frozen);
  const expected = policy.expectedFor(indicator, c.base);
  const latest = latestMonthOf(indicator, c);
  const meta = store.readMeta();
  const catMeta = cat ? (meta.catalogs || {})[cat.id] || {} : {};

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
    expectedLatest: archived ? '' : expected,
    latestCached: latest,
    // 上游已停更的序列（旧口径网上零售）永远不算滞后
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
  const history = config.historyRange();
  const from = o.from || history.from;
  const to = o.to || expectedBase();

  const r = await ensureAll({ force: o.force });
  const ctx = makeContext();
  const pts = points(indicator, from, to, ctx);
  const desc = descriptor(indicator, ctx);
  const valid = pts.filter((x) => x.value !== null);
  return Object.assign({}, desc, {
    from: from,
    to: to,
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

/**
 * 全量：前端一次请求拿到全部图的数据
 * @param {{from?:string, to?:string, force?:boolean}} opts from/to 为 'YYYY-MM'
 */
async function overview(opts) {
  const o = opts || {};
  const history = config.historyRange();
  const base = expectedBase();
  const from = o.from || history.from;
  const to = o.to || base;
  const startedAt = Date.now();

  const before = store.stats();
  const cold = !before.catalogs;
  const latest = before.latest;
  const lag = latest ? policy.monthSpan(latest < base ? latest : base, base).length - 1 : 99;

  // 首次运行整段拉全；落后 3 期以上同步补齐；其余交给后台
  const sync = cold || lag >= 3;
  let fetched = 0;
  let errors = [];
  if (cold || o.force || sync) {
    const r = await ensureAll({ force: o.force });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  }

  const ctx = makeContext();
  // 冷启动补拉后再算一次落后程度，决定要不要再排后台任务
  const afterLag = ctx.stats.latest
    ? policy.monthSpan(ctx.stats.latest < base ? ctx.stats.latest : base, base).length - 1
    : 99;

  const items = config.list().map((indicator) => {
    const desc = descriptor(indicator, ctx);
    const pts = points(indicator, from, to, ctx);
    const valid = pts.filter((x) => x.value !== null);
    return Object.assign({}, desc, {
      points: pts,
      latest: valid.length ? valid[valid.length - 1] : null,
      prev: valid.length > 1 ? valid[valid.length - 2] : null,
    });
  });

  // 后台核对：只有落后应发布月份时才发起，首屏不等它
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
  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range: { from: from, to: to },
    history: { from: history.from, to: '' },
    expectedLatest: base,
    latestMonth: ctx.stats.latest,
    fetched: fetched,
    refreshing: refreshing,
    errors: errors,
    stale: items.some((x) => x.stale) || errors.length > 0,
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
  const base = expectedBase();
  const behind = !stats.latest || stats.latest < base ? 1 : 0;
  return {
    dir: stats.dir,
    catalogs: stats.catalogs,
    series: stats.series,
    points: stats.points,
    months: stats.months,
    historyFrom: config.historyRange().from,
    latest: stats.latest,
    expected: base,
    behind: behind,
  };
}

module.exports = {
  ensureAll,
  ensureCatalog,
  points,
  descriptor,
  describeAll,
  getSeries,
  overview,
  datasetStatus,
  toValue,
  valueAt,
  expectedBase,
  latestMonthOf,
};
