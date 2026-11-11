'use strict';

/**
 * 行业运行序列服务：缓存优先——首次运行把 2018 年以来的历史拉全，
 * 之后每次打开只核对应发布期别，缺哪一期补哪一期
 *
 * 落盘的只有上游原值（%）。本页不合成任何指数、不做加权、不插值：
 *   增加值   统计局发布的规模以上工业增加值当月同比（0 = 持平，1、2 月合并公布）
 *   营业收入 1—N 月累计同比
 *   利润总额 1—N 月累计同比
 *   PMI      扩散指数（50 = 荣枯线），与上面三类的量纲完全不同
 * 三类行业口径与 PMI 只在页面上并列展示，绝不混画同一条曲线。
 *
 * 三个行业栏目 + 两个 PMI 栏目各有自己的发布日，回源判定统一走 policy.js。
 *
 * 四分类（与宏观 / 社零同款语义）：
 *   cold   一个栏目文件都没有：首次运行，把 2018 到应发布月份整段拉全再渲染
 *   behind 最新缓存月落后应发布月份 3 期以上（包放了半年才打开）：同步补齐再渲染
 *   warm   基本跟上：先用缓存出图，只在「应发布月份还没落缓存」时后台核对
 * 上游失败一律回退缓存并标 stale，绝不返回空数组、绝不插值补 0。
 */

const config = require('./config');
const store = require('./store');
const policy = require('./policy');
const source = require('./source');

let lastMarkAt = new Map();

function blocked(key, ms) {
  const prev = lastMarkAt.get(key) || 0;
  return Date.now() - prev < ms;
}

function mark(key) {
  lastMarkAt.set(key, Date.now());
}

function decimalsOf(indicator) {
  return typeof indicator.decimals === 'number' ? indicator.decimals : 1;
}

/** 原值 → 展示值（定点取整） */
function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  const f = Math.pow(10, decimalsOf(indicator));
  return Math.round(raw * f) / f;
}

/** 各栏目的应发布月份（按栏目自己的发布日规则现算） */
function baseByCatalog() {
  const out = {};
  config.catalogs().forEach((cat) => {
    out[cat.id] = policy.expectedLatestMonth(cat.release, new Date());
  });
  return out;
}

/** PMI 两个栏目里较晚的那个应发布月份（当月月末就有，比工业口径早半个月） */
function pmiBase(base) {
  const b = base || baseByCatalog();
  const list = [b.mfg_pmi, b.nonmfg_pmi].filter(Boolean).sort();
  return list.length ? list[list.length - 1] : '';
}

/** 一个栏目缓存的最新月份落后应发布月份多少期 */
function lagOfCatalog(cat, cached, base) {
  const required = requiredOf(cat, base);
  if (!required) return 0;
  const latest = latestOf(cached);
  if (!latest) return 99; // 该栏目还没缓存过
  const upper = latest < required ? latest : required;
  return policy.monthSpan(upper, required).length - 1;
}

/** 所有栏目里最严重的落后期数（PMI 早已更新不能掩盖工业口径的滞后） */
function lagOf(base) {
  const b = base || baseByCatalog();
  let worst = 0;
  config.catalogs().forEach((cat) => {
    const lag = lagOfCatalog(cat, store.readCatalog(cat.id), b);
    if (lag > worst) worst = lag;
  });
  return worst;
}

/** 某个指标应发布到哪个月（扣掉本身就不发布的月份） */
function expectedOf(indicator, base) {
  const cat = config.catalogOf(indicator.catalog);
  return policy.expectedFor(indicator, cat.release, base ? base[cat.id] : '', new Date());
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

function indicatorsOfCatalog(key) {
  return config.list().filter((ind) => ind.catalog === key);
}

/** 该栏目名下指标里最晚的应发布月份（已扣掉本身就不发布的月份） */
function requiredOf(cat, base) {
  let need = '';
  indicatorsOfCatalog(cat.id).forEach((ind) => {
    const e = expectedOf(ind, base);
    if (e > need) need = e;
  });
  return need || (base && base[cat.id]) || '';
}

/**
 * 补一个栏目（失败只记录，不抛错）
 * @param {object} cat 栏目配置
 * @param {{force?:boolean, dryRun?:boolean, base?:Object}} opts
 */
async function ensureCatalog(cat, opts) {
  const o = opts || {};
  const res = { key: cat.id, fetched: 0, pending: 0, error: '' };
  const cached = store.readCatalog(cat.id);
  const base = o.base || baseByCatalog();
  const required = requiredOf(cat, base);

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
  if (blocked('industry:' + cat.id, policy.COOLDOWN_MS)) return res;

  const history = config.historyRange();
  const from = cat.from && cat.from > history.from ? cat.from : history.from;
  const to = cat.to && cat.to < required ? cat.to : required;
  if (!required || to < from) return res; // 上游这一期还没开始发布

  const ids = indicatorsOfCatalog(cat.id).map((ind) => ind.indicatorId);
  if (!ids.length) return res;

  mark('industry:' + cat.id);
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
  const base = o.base || baseByCatalog();
  const out = { fetched: 0, errors: [], pending: 0 };
  let fails = 0;
  for (const cat of config.catalogs()) {
    const one = await ensureCatalog(cat, Object.assign({}, o, { base: base }));
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

/* ---------------- 从缓存拼数据 ---------------- */

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

function rawAt(index, indicator, month) {
  const m = index.get(indicator.catalog + '|' + indicator.indicatorId);
  const v = m ? m[month] : undefined;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function makeContext() {
  const stats = store.stats();
  const base = baseByCatalog();
  return {
    index: makeIndex(),
    base: base,
    stats: stats,
    horizon: base.output && stats.latest < base.output ? base.output : stats.latest,
  };
}

/** 指标在区间内的点：缺月为 null，不插值 */
function points(indicator, from, to, ctx) {
  const c = ctx || makeContext();
  return policy.monthSpan(from, to).map((month) => {
    const raw = rawAt(c.index, indicator, month);
    return { month: month, value: toValue(indicator, raw) };
  });
}

/** 指标在区间内最后一个有值的点 */
function lastPoint(pointsArr) {
  for (let i = pointsArr.length - 1; i >= 0; i -= 1) {
    if (pointsArr[i].value !== null) return pointsArr[i];
  }
  return null;
}

function descriptor(indicator, ctx, base) {
  const c = ctx || makeContext();
  const b = base || c.base;
  const expected = expectedOf(indicator, b);
  const latest = latestMonthOf(indicator, c, b);
  const meta = store.readMeta();
  const catMeta = (meta.catalogs || {})[indicator.catalog] || {};
  return {
    id: indicator.id,
    label: indicator.label,
    shortLabel: indicator.shortLabel || indicator.label,
    unit: indicator.unit,
    kind: indicator.kind,
    group: indicator.group || '',
    decimals: decimalsOf(indicator),
    note: indicator.note || '',
    historyFrom: config.historyRange().from,
    industry: indicator.industry || '',
    metric: indicator.metric || '',
    expectedLatest: expected,
    latestCached: latest,
    stale: !latest || latest < expected,
    lastSuccess: catMeta.lastSuccess || '',
  };
}

/** 该指标最新一个「有值」的月份（在历史起点到应发布月份之间往回找） */
function latestMonthOf(indicator, ctx, base) {
  const c = ctx || makeContext();
  const b = base || c.base;
  const cat = config.catalogOf(indicator.catalog);
  let end = b[cat.id] || c.horizon;
  const archiveEnd = cat.frozen && cat.to ? cat.to : '';
  if (archiveEnd && archiveEnd < end) end = archiveEnd;
  const from = config.historyRange().from;
  if (!end || end < from) return '';
  const span = policy.monthSpan(from, end);
  for (let i = span.length - 1; i >= 0; i -= 1) {
    if (rawAt(c.index, indicator, span[i]) !== null) return span[i];
  }
  return '';
}

/** 只读缓存的指标清单：一次读盘，供 /indicators 用 */
function describeAll() {
  const ctx = makeContext();
  return config.list().map((ind) => descriptor(ind, ctx));
}

/** 一个行业在当前区间内的三条序列（只保留有值的月份，减少传输体积） */
function industryBlock(ind, from, to, ctx) {
  const rows = config.indicatorsOfIndustry(ind.key);
  const block = {
    key: ind.key,
    label: ind.label,
    shortLabel: ind.shortLabel,
    group: ind.group,
    latest: {},
    stale: false,
    output: {},
    revenue: {},
    profit: {},
  };
  rows.forEach((indicator) => {
    const pts = points(indicator, from, to, ctx);
    const map = {};
    pts.forEach((p) => {
      if (p.value !== null) map[p.month] = p.value;
    });
    block[indicator.metric] = map;
    block.latest[indicator.metric] = lastPoint(pts);
    if (descriptor(indicator, ctx).stale) block.stale = true;
  });
  return block;
}

/** PMI 分项（区间内的点，保留 null 以便断线） */
function pmiBlock(p, from, to, ctx) {
  const indicator = config.byId(p.id);
  const pts = points(indicator, from, to, ctx);
  const desc = descriptor(indicator, ctx);
  return {
    id: indicator.id,
    label: indicator.label,
    shortLabel: descriptor(indicator, ctx).shortLabel,
    note: indicator.note || '',
    group: indicator.group,
    points: pts,
    latest: lastPoint(pts),
    stale: desc.stale,
    expectedLatest: desc.expectedLatest,
  };
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
 * 全量：前端一次请求拿到三块图的数据
 * @param {{from?:string, to?:string, force?:boolean}} opts from/to 为 'YYYY-MM'
 */
async function overview(opts) {
  const o = opts || {};
  const history = config.historyRange();
  const base = baseByCatalog();
  const from = o.from || history.from;
  // 展示到「最晚的那个应发布月份」：PMI 当月月末就有，行业口径要等下个月中旬
  const pmiExpected = pmiBase(base);
  const expectedLatest = [base.output, base.revenue, base.profit, pmiExpected].filter(Boolean).sort().pop();
  const to = o.to || expectedLatest;
  const startedAt = Date.now();

  const before = store.stats();
  const cold = !before.catalogs;
  const lag = lagOf(base);

  // 首次运行整段拉全；落后 3 期以上同步补齐；其余交给后台
  const sync = cold || lag >= 3;
  let fetched = 0;
  let errors = [];
  if (cold || o.force || sync) {
    const r = await ensureAll({ force: o.force, base: base });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  }

  const ctx = makeContext();
  const afterLag = lagOf(base);

  const industries = config.industries().map((ind) => industryBlock(ind, from, to, ctx));
  const pmi = config.pmiList().map((p) => pmiBlock(p, from, to, ctx));

  // 后台核对：只有落后应发布月份时才发起，首屏不等它
  let refreshing = 0;
  if (!o.force && !cold && afterLag > 0) {
    const probe = await ensureAll({ dryRun: true, base: base });
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
    expected: {
      output: base.output,
      revenue: base.revenue,
      profit: base.profit,
      pmi: pmiExpected,
    },
    expectedLatest: expectedLatest,
    latestMonth: ctx.stats.latest,
    fetched: fetched,
    refreshing: refreshing,
    errors: errors,
    stale:
      // 只看「栏目层面是否逾期」：某个行业在某个口径上没有值，可能是累计同比基数
      // 为负时统计局本来就不发布（见 policy.js 与 README），不能当成整页滞后
      afterLag > 0 || errors.length > 0,
    groups: settings.groups,
    metrics: settings.metrics,
    source: settings.source,
    industries: industries,
    pmi: pmi,
    firstRun: cold,
    cache: ctx.stats,
  };
}

/** 单指标：先 ensure 再取数 */
async function getSeries(id, opts) {
  const o = opts || {};
  const indicator = config.byId(id);
  const history = config.historyRange();
  const base = baseByCatalog();
  const from = o.from || history.from;
  const to = o.to || expectedOf(indicator, base);

  const r = await ensureAll({ force: o.force, base: base });
  const ctx = makeContext();
  const pts = points(indicator, from, to, ctx);
  const desc = descriptor(indicator, ctx, base);
  return Object.assign({}, desc, {
    from: from,
    to: to,
    points: pts,
    latest: lastPoint(pts),
    prev: (function () {
      const valid = pts.filter((x) => x.value !== null);
      return valid.length > 1 ? valid[valid.length - 2] : null;
    })(),
    fetched: r.fetched > 0,
    fetchReason: r.errors && r.errors.length ? r.errors[0] : '',
  });
}

/** 数据集概况：只读本地文件，不回源，供启动日志与健康检查使用 */
function datasetStatus() {
  const stats = store.stats();
  const base = baseByCatalog();
  const behind = lagOf(base);
  return {
    dir: stats.dir,
    catalogs: stats.catalogs,
    series: stats.series,
    points: stats.points,
    months: stats.months,
    historyFrom: config.historyRange().from,
    industries: config.industries().length,
    latest: stats.latest,
    expected: base.output,
    expectedPmi: pmiBase(base),
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
  expectedOf,
  baseByCatalog,
  pmiBase,
  lagOf,
  latestMonthOf,
};
