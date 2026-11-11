'use strict';

/**
 * 区域经济序列服务：缓存优先——首次运行把 31 个省 1992 年以来的地区生产总值
 * 一次拉全，之后每次打开只核对应发布年度，缺哪一年补哪一年。
 *
 * 取数成本与其它模块不同：分省库的 das 一次只认一个地区，31 个省就是 31 次请求。
 * 因此首轮只同步拉「地区生产总值」栏目（31 次 ≈ 40 秒），
 * 「地区生产总值指数」（官方实际增速）在首屏返回后由后台补齐，前端按 refreshing 提示。
 *
 * 落盘的只有上游原值（亿元 / 元 / 上年=100），以下都是现算的：
 *   产业占比 = 该产业增加值 ÷ GDP × 100
 *   名义增速 = (当年 GDP − 上年 GDP) ÷ 上年 GDP × 100
 * 公式改了不用清缓存；把计算值落盘反而会让口径改动后新旧数据混在一起。
 *
 * 三分类（与其它模块同款语义）：
 *   cold   一个省文件都没有：首次运行，先拉 GDP 栏目再渲染
 *   behind 最新缓存年度落后应发布年度 3 年以上（包放很久才打开）：同步补齐再渲染
 *   warm   基本跟上：先用缓存出图，只在「应发布年度还没落缓存」时后台核对
 * 上游失败一律回退缓存并标 stale，绝不返回空数组、绝不插值补 0。
 */

const config = require('./config');
const store = require('./store');
const policy = require('./policy');
const source = require('./source');
const { blocked, mark } = require('./queue');

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

/** 计算量的浮点噪声裁到 4 位小数再交给 toValue */
function clean(x) {
  return Math.round(x * 10000) / 10000;
}

function catalogKeys() {
  return config.catalogs().map((c) => c.key);
}

function indicatorsOfCatalog(key) {
  return config.list().filter((ind) => ind.catalog === key);
}

function fetchIdsOf(key) {
  return indicatorsOfCatalog(key).map((ind) => ind.indicatorId);
}

/** 全部栏目中最晚的应发布年度（releaseMonth 统一，所以就是一个值） */
function expectedYear(now) {
  return policy.expectedYear(config.releaseMonth(), now || new Date());
}

/**
 * 单个指标应发布到哪一年：行业增加值与分产业指数随《中国统计年鉴》入库，
 * 比 GDP 晚一年（配置里的 lagYears），搞混了会让页面永远显示“数据滞后”。
 */
function expectedOfIndicator(indicator) {
  const base = Number(expectedYear());
  const lag = Number(indicator && indicator.lagYears) || 0;
  return String(base - lag);
}

/** 某栏目应发布到哪一年：取该栏目下最晚的那个指标 */
function requiredOfCatalog(key) {
  const base = Number(expectedYear());
  let need = base - 2;
  indicatorsOfCatalog(key).forEach((ind) => {
    const one = base - (Number(ind.lagYears) || 0);
    if (one > need) need = one;
  });
  return String(need);
}

/** 某省某个栏目缓存里最新的年度 */
function latestOfCatalog(cached, key) {
  if (!cached || !cached.series) return '';
  let latest = '';
  fetchIdsOf(key).forEach((iid) => {
    const map = cached.series[iid] || {};
    Object.keys(map).forEach((y) => {
      if (y > latest) latest = y;
    });
  });
  return latest;
}

/** 某省单个指标的缓存里最新的年度 */
function latestOfIndicator(cached, indicatorId) {
  if (!cached || !cached.series) return '';
  const map = cached.series[indicatorId] || {};
  let latest = '';
  Object.keys(map).forEach((y) => {
    if (y > latest) latest = y;
  });
  return latest;
}

/**
 * 某栏目还落后几年：逐个指标比，不能拿栏目内最新的一年代表整栏。
 * GDP 已到 2025、行业增加值仍停在 2023 时，栏目级看是「齐的」，只有指标级才看得出缺口。
 *
 * 整条没有缓存的指标分两种：
 *   - 该省这一栏目从没拉成功过（首轮只同步拉了 GDP）：算落后，得补；
 *   - 栏目已经拉成功过（meta.lastSuccess）仍空：那就是上游没有这一项，再拉也是白拉。
 */
function gapOfCatalog(cached, key, provinceMeta) {
  const pulled = !!(provinceMeta && provinceMeta[key] && provinceMeta[key].lastSuccess);
  let gap = 0;
  let seen = 0;
  indicatorsOfCatalog(key).forEach((ind) => {
    if (!ind.indicatorId) return;
    const latest = latestOfIndicator(cached, ind.indicatorId);
    if (!latest) {
      if (!pulled) gap = Math.max(gap, 1);
      return;
    }
    seen += 1;
    const one = policy.gapOf(latest, expectedOfIndicator(ind));
    if (one > gap) gap = one;
  });
  if (!seen && !pulled) return policy.gapOf('', expectedYear());
  return gap;
}

/** 某省所有栏目里最新的年度 */
function latestOfProvince(cached) {
  let latest = '';
  catalogKeys().forEach((key) => {
    const one = latestOfCatalog(cached, key);
    if (one > latest) latest = one;
  });
  return latest;
}

/* ---------------- 回源 ---------------- */

/**
 * 补一个省（失败只记录，不抛错）
 * @param {object} prov 省份配置
 * @param {{force?:boolean, dryRun?:boolean, catalogs?:string[], required?:string}} opts
 */
async function ensureProvince(prov, opts) {
  const o = opts || {};
  const res = { code: prov.code, fetched: 0, requests: 0, touched: false, error: '' };
  const cached = store.readProvince(prov.code);
  const required = o.required || expectedYear();
  const history = config.historyRange();

  const meta = store.readMeta();
  meta.provinces = meta.provinces || {};
  const pMeta = meta.provinces[prov.code] || {};

  const todo = (o.catalogs && o.catalogs.length ? o.catalogs : catalogKeys()).filter((key) => {
    const cat = config.getCatalog(key);
    const required = o.required || requiredOfCatalog(key);
    if (cat.from && String(cat.from) > required) return false;
    if (o.force) return true;
    return gapOfCatalog(cached, key, pMeta) > 0;
  });
  if (!todo.length) return res;

  // 冷却按「省 + 栏目」判：首轮拉 GDP 栏目不该把紧接着的指数回源一起拦掉
  const ready = todo.filter((key) => {
    if (o.force) return true;
    const m = pMeta[key] || {};
    if (m.lastAttempt && Date.now() - Date.parse(m.lastAttempt) < policy.TRY_INTERVAL_MS) return false;
    if (blocked('region:' + prov.code + ':' + key, policy.COOLDOWN_MS)) return false;
    return true;
  });
  if (!ready.length) return res;
  if (o.dryRun) {
    res.requests = ready.length;
    return res;
  }

  for (const key of ready) {
    const cat = config.getCatalog(key);
    const ids = fetchIdsOf(key);
    if (!ids.length) continue;

    const base = cat.from && cat.from > history.from ? cat.from : history.from;
    const to = cat.to && cat.to < required ? cat.to : required;
    if (to < base) continue; // 上游这一期还没开始发布

    mark('region:' + prov.code + ':' + key);
    const before = store.readMeta();
    before.provinces = before.provinces || {};
    const bp = before.provinces[prov.code] || {};
    bp[key] = Object.assign({}, bp[key] || {}, { lastAttempt: new Date().toISOString() });
    before.provinces[prov.code] = bp;
    store.writeMeta(before);

    try {
      const got = await source.fetchRange({
        catalogId: cat.catalogId,
        indicatorIds: ids,
        province: prov,
        from: base,
        to: to,
      });

      // 合并而不是覆盖：补新年份时别把已有年份冲掉，同年份以上游新值为准。
      // 落盘前重读一次，避免与并发刷新拿着同一份旧快照互相覆盖
      const fresh = store.readProvince(prov.code) || cached;
      const prev = (fresh && fresh.series) || {};
      const series = Object.assign({}, prev);
      Object.keys(got).forEach((iid) => {
        series[iid] = Object.assign({}, prev[iid] || {}, got[iid]);
      });
      store.writeProvince(prov.code, {
        name: prov.name,
        series: series,
        from: (fresh && fresh.from) || base,
        to: to,
        fetchedAt: new Date().toISOString(),
      });
      res.fetched += 1;
      res.requests += 1;
      res.touched = true;

      const after = store.readMeta();
      after.provinces = after.provinces || {};
      const ap = after.provinces[prov.code] || {};
      ap[key] = Object.assign({}, ap[key] || {}, {
        lastSuccess: new Date().toISOString(),
        lastError: null,
        latest: latestOfCatalog(store.readProvince(prov.code), key),
      });
      after.provinces[prov.code] = ap;
      store.writeMeta(after);
    } catch (e) {
      res.requests += 1;
      const after = store.readMeta();
      after.provinces = after.provinces || {};
      const ap = after.provinces[prov.code] || {};
      ap[key] = Object.assign({}, ap[key] || {}, { lastError: e.message });
      after.provinces[prov.code] = ap;
      store.writeMeta(after);
      res.error = prov.name + ' · ' + cat.label + '：' + e.message;
    }
  }

  return res;
}

/** 把所有省核一遍（串行，限流在 source 里） */
async function ensureAll(opts) {
  const o = opts || {};
  const out = { fetched: 0, requests: 0, errors: [], provinces: 0 };
  const required = expectedYear();
  let fails = 0;

  for (const prov of config.provinces()) {
    const one = await ensureProvince(prov, {
      force: o.force,
      dryRun: o.dryRun,
      catalogs: o.catalogs,
      required: required,
    });
    out.fetched += one.fetched;
    out.requests += one.requests;
    if (one.touched) out.provinces += 1;

    if (one.error) {
      out.errors.push(one.error);
      fails += 1;
      // 连续三个省都拿不到：上游整体不可用，剩下的不再一个个试，直接用缓存
      if (fails >= 3) {
        out.errors.push('连续 ' + fails + ' 个省份回源失败，本次不再继续尝试');
        break;
      }
    } else if (one.requests) {
      fails = 0;
    }
  }
  return out;
}

/** 指定栏目里所有省最大的缺口（逐指标算，不拿栏目最大值） */
function maxLagOf(keys) {
  const list = keys && keys.length ? keys : catalogKeys();
  const meta = store.readMeta();
  let lag = 0;
  config.provinces().forEach((p) => {
    const cached = store.readProvince(p.code);
    const pMeta = (meta.provinces || {})[p.code] || {};
    list.forEach((key) => {
      const one = gapOfCatalog(cached, key, pMeta);
      if (one > lag) lag = one;
    });
  });
  return lag;
}

/** 所有省所有栏目里最大的缺口，用于决定要不要同步补齐 */
function maxLag() {
  return maxLagOf(catalogKeys());
}

/** 后台补拉：同一时刻只跑一份，不重复堆任务 */
const bgJobs = new Map();

function refreshInBackground() {
  const key = 'all';
  if (bgJobs.has(key)) return;
  const job = (async () => {
    await ensureAll({});
  })();
  bgJobs.set(
    key,
    job.then(
      () => bgJobs.delete(key),
      () => bgJobs.delete(key)
    )
  );
}

/* ---------------- 从缓存拼序列 ---------------- */

/** 一次请求内只读一遍全部省文件 */
function makeIndex() {
  const map = new Map();
  config.provinces().forEach((p) => {
    const one = store.readProvince(p.code);
    if (one) map.set(p.code, one);
  });
  return map;
}

function rawAt(index, code, indicatorId, year) {
  const one = index.get(code);
  const m = one && one.series && one.series[indicatorId];
  const v = m ? m[year] : undefined;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 指标在某省某年的值：原值直取，计算量现算（缺任一项就是缺失，不补 0） */
function valueAt(id, code, year, index) {
  const ind = config.byId(id);
  if (!ind.derive) return rawAt(index, code, ind.indicatorId, year);

  if (ind.derive === 'share_pct') {
    const a = valueAt(ind.inputs[0], code, year, index);
    const b = valueAt(ind.inputs[1], code, year, index);
    if (a === null || b === null || b === 0) return null;
    return clean((a / b) * 100);
  }
  if (ind.derive === 'yoy_nominal') {
    const a = valueAt(ind.inputs[0], code, year, index);
    const p = valueAt(ind.inputs[0], code, String(Number(year) - 1), index);
    if (a === null || p === null || p === 0) return null;
    return clean(((a - p) / p) * 100);
  }
  return null;
}

function makeContext(req) {
  return {
    index: makeIndex(),
    req: req,
    stats: store.stats(),
    expected: expectedYear(),
    history: config.historyRange(),
  };
}

/** 指标要画的年度区间 */
function seriesRange(req) {
  const history = config.historyRange();
  const base = expectedYear();
  const from = req && policy.isYear(req.from) && req.from > history.from ? req.from : history.from;
  const to = req && policy.isYear(req.to) && req.to < base ? req.to : base;
  return { from: from, to: to };
}

/** 一次生成全部省 × 全部指标的紧凑序列：{ 省码: { 指标id: { 年份: 值 } } } */
function buildData(range, index) {
  const years = policy.yearSpan(range.from, range.to).slice(0, HISTORY_YEARS_CAP);
  const list = config.list();
  const out = {};

  config.provinces().forEach((p) => {
    const per = {};
    list.forEach((ind) => {
      const map = {};
      years.forEach((y) => {
        const raw = valueAt(ind.id, p.code, y, index);
        if (raw !== null) map[y] = toValue(ind, raw);
      });
      if (Object.keys(map).length) per[ind.id] = map;
    });
    out[p.code] = per;
  });

  return out;
}

/**
 * 某指标「各省都到哪一年了」：取各省最新年度的最小值。
 * 用最大值会把落后的省藏起来（31 省里 30 个到 2025、1 个停 2023 也是「最新 2025」）。
 */
function latestYearOf(indicatorId, data) {
  let latest = '';
  let missing = false;
  config.provinces().forEach((p) => {
    const m = data[p.code] && data[p.code][indicatorId];
    let one = '';
    if (m) {
      Object.keys(m).forEach((y) => {
        if (y > one) one = y;
      });
    }
    if (!one) {
      missing = true;
      return;
    }
    if (!latest || one < latest) latest = one;
  });
  // 有一个省整条没有，就不能再说「最新到某年」
  return missing ? '' : latest;
}

/** 该指标有数据的省份数（缺失的省不补 0） */
function coverageOf(indicatorId, data) {
  let n = 0;
  config.provinces().forEach((p) => {
    const m = data[p.code] && data[p.code][indicatorId];
    if (m && Object.keys(m).length) n += 1;
  });
  return n;
}

function descriptor(indicator, data) {
  const latest = latestYearOf(indicator.id, data);
  const expected = expectedOfIndicator(indicator);
  const covered = coverageOf(indicator.id, data);
  const total = config.provinces().length;
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
    primary: !!indicator.primary,
    lagYears: Number(indicator.lagYears) || 0,
    historyFrom: config.historyRange().from,
    expectedLatest: expected,
    latestCached: latest,
    // 省份缺了同样算不齐：整页只在数据真的齐全时才报「完整」
    provinces: covered,
    totalProvinces: total,
    stale: policy.isStale(latest, expected) || covered < total,
    // 计算口径：前端图注直接显示，避免把计算值当成官方发布值
    computed: !!indicator.derive,
  };
}

/** 最近一次回源错误（按省） */
function lastErrorOf() {
  const meta = store.readMeta();
  const out = [];
  config.provinces().forEach((p) => {
    const per = (meta.provinces || {})[p.code] || {};
    Object.keys(per).forEach((key) => {
      const one = per[key] || {};
      if (one.lastError) out.push(p.name + ' · ' + key + '：' + one.lastError);
    });
  });
  return out.slice(0, 8);
}

/* ---------------- 对外 ---------------- */

/**
 * 全量：前端一次请求拿到全部图的数据
 * @param {{from?:string, to?:string, force?:boolean}} opts from/to 为 'YYYY'
 */
async function overview(opts) {
  const o = opts || {};
  const startedAt = Date.now();
  const range = seriesRange({ from: o.from, to: o.to });

  const before = store.stats();
  const cold = !before.provinces;
  // 同步补齐只看首屏必需的 GDP 栏目：官方指数栏目按设计就是后台补，
  // 不能因为它缺就让每个轮询请求都重走 31 次上游（否则首屏反而要等几十秒）
  const lagBefore = maxLagOf(['gdp']);
  const busy = bgJobs.size > 0;

  let fetched = 0;
  let errors = [];

  if (o.force) {
    const r = await ensureAll({ force: true });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  } else if (cold || (lagBefore >= 3 && !busy)) {
    // 首次只同步拉 GDP 栏目（31 次请求）；落后 3 年以上（包放很久才打开）也同步补齐 GDP
    const r = await ensureAll({ catalogs: ['gdp'] });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  }

  const ctx = makeContext(range);
  const lagAfter = maxLag();

  // 后台核对：首屏不等它
  let refreshing = 0;
  if (!o.force) {
    const probe = await ensureAll({ dryRun: true });
    if (probe.requests) {
      refreshing = probe.requests;
      refreshInBackground();
    } else if (bgJobs.size) {
      refreshing = 1;
    }
  }

  const data = buildData(range, ctx.index);
  // 指标新鲜度按「全量区间」算：请求只取近 10 年时，不能因为窗口里没有 2025 就标成过期
  const fullRange = seriesRange(null);
  const full =
    range.from === fullRange.from && range.to === fullRange.to ? data : buildData(fullRange, ctx.index);
  const base = expectedYear();
  const items = config.list().map((ind) => descriptor(ind, full));
  const settings = config.settings();
  const cached = config.load();

  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range: range,
    history: { from: settings.history.from, note: cached.history.note || '' },
    expectedYear: base,
    expectedLatest: base,
    releaseMonth: settings.releaseMonth,
    latestYear: ctx.stats.latestYear,
    fetched: fetched,
    refreshing: refreshing,
    errors: errors.concat(lastErrorOf()),
    stale: items.some((x) => x.stale),
    groups: settings.groups,
    source: cached.source || {},
    provinces: config.provinces(),
    indicators: items,
    data: data,
    firstRun: cold,
    cache: ctx.stats,
  };
}

/** 单指标：先 ensure 再取数（可按省份过滤） */
async function getSeries(id, opts) {
  const o = opts || {};
  const indicator = config.byId(id);
  const range = seriesRange({ from: o.from, to: o.to });

  await ensureAll({ force: o.force });

  const index = makeIndex();
  const provinces = config.resolveProvinces(o.provinces);
  const years = policy.yearSpan(range.from, range.to).slice(0, HISTORY_YEARS_CAP);
  // 单个指标按自己的 lagYears 判应发布年度，和 overview / 健康检查保持同一口径
  const base = expectedOfIndicator(indicator);

  const series = provinces.map((p) => {
    const points = years.map((y) => {
      const raw = valueAt(indicator.id, p.code, y, index);
      return { year: y, value: toValue(indicator, raw) };
    });
    const valid = points.filter((x) => x.value !== null);
    let latest = '';
    valid.forEach((x) => {
      if (x.year > latest) latest = x.year;
    });
    return {
      code: p.code,
      name: p.name,
      short: p.short,
      points: points,
      latest: valid.length ? valid[valid.length - 1] : null,
      latestCached: latest,
      stale: policy.isStale(latest, base),
    };
  });

  return {
    id: indicator.id,
    label: indicator.label,
    shortLabel: indicator.shortLabel || indicator.label,
    unit: indicator.unit,
    kind: indicator.kind,
    decimals: decimalsOf(indicator),
    note: indicator.note || '',
    computed: !!indicator.derive,
    from: range.from,
    to: range.to,
    expectedLatest: base,
    series: series,
  };
}

/** 横截面排名：同一年的所有省按值降序，缺值不参与、同值并列 */
async function rank(metricId, query) {
  const o = query || {};
  const indicator = config.byId(metricId);
  await ensureAll({ force: o.force });

  const index = makeIndex();
  const base = expectedYear();
  const year = policy.isYear(o.year) && o.year < base ? o.year : base;

  const rows = [];
  config.provinces().forEach((p) => {
    const raw = valueAt(indicator.id, p.code, year, index);
    if (raw === null) return;
    rows.push({ code: p.code, name: p.name, short: p.short, value: toValue(indicator, raw) });
  });
  rows.sort((a, b) => b.value - a.value);

  let prevValue = null;
  let prevRank = 0;
  rows.forEach((row, i) => {
    if (prevValue !== null && row.value === prevValue) row.rank = prevRank;
    else {
      row.rank = i + 1;
      prevRank = row.rank;
      prevValue = row.value;
    }
  });

  return {
    metric: indicator.id,
    label: indicator.label,
    unit: indicator.unit,
    kind: indicator.kind,
    decimals: decimalsOf(indicator),
    computed: !!indicator.derive,
    year: year,
    expectedLatest: base,
    // 参与排名的省份数；缺值省份另行列出，避免被误读成 0
    ranked: rows.length,
    missing: config
      .provinces()
      .filter((p) => !rows.some((r) => r.code === p.code))
      .map((p) => ({ code: p.code, name: p.name })),
    provinces: rows,
  };
}

/** 只读缓存的指标清单 */
function describeAll() {
  const index = makeIndex();
  const range = seriesRange(null);
  const data = buildData(range, index);
  return config.list().map((ind) => descriptor(ind, data));
}

/** 数据集概况：只读本地文件，不回源，供启动日志与健康检查使用 */
function datasetStatus() {
  const stats = store.stats();
  const base = expectedYear();
  const lag = maxLag();
  return {
    dir: stats.dir,
    provinces: stats.provinces,
    total: config.provinces().length,
    series: stats.series,
    points: stats.points,
    years: stats.years,
    historyFrom: config.historyRange().from,
    latestYear: stats.latestYear,
    expectedYear: base,
    lag: lag,
    behind: lag > 0,
  };
}

module.exports = {
  ensureAll,
  ensureProvince,
  overview,
  getSeries,
  rank,
  describeAll,
  datasetStatus,
  expectedYear,
  expectedOfIndicator,
  requiredOfCatalog,
  latestOfProvince,
  toValue,
  valueAt,
};
