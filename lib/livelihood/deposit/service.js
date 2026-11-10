'use strict';

/**
 * 居民存款序列服务：缓存优先——首次运行按年把 2015 年以来的历史拉全，之后只核对当年
 *
 * 落盘的只有上游原值（住户存款 / 活期 / 定期，亿元），下面这些量都是现算的：
 *   当月新增 = 本月余额 − 上月余额
 *   年初至今 = 本月余额 − 上年 12 月余额
 *   同比     = 本月余额 ÷ 上年同月余额 − 1
 *   人均存款 = 每年 12 月余额 ÷ 当年年末总人口（亿元 ÷ 万人 = 万元/人）
 * 公式改了不用清缓存；相反，把计算值落盘反而会让口径改动后新旧数据混在一起。
 *
 * 四分类（与宏观 / 婚育 / 人均收支同款语义）：
 *   cold   一个年份文件都没有：首次运行，把 2015 到应发布月份整段拉全再渲染
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
  return typeof indicator.decimals === 'number' ? indicator.decimals : 2;
}

/** 原值 → 展示值（scale 折算 + 定点取整） */
function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  const scale = typeof indicator.scale === 'number' ? indicator.scale : 1;
  const f = Math.pow(10, decimalsOf(indicator));
  return Math.round(raw * scale * f) / f;
}

/** ['2026-01','2026-02', ...] 含首尾 */
function monthSpan(from, to) {
  const out = [];
  let cur = from;
  while (cur && cur <= to && out.length < 400) {
    out.push(cur);
    cur = policy.addMonths(cur, 1);
  }
  return out;
}

function expectedMonth() {
  return policy.expectedLatestMonth(new Date());
}

/** 年末总人口：统计年 Y 的人口在 Y 年末才发布，所以目标年 = 应发布月份所在年（12 月）或上一年 */
function populationTargetYear() {
  const expected = expectedMonth();
  const year = Number(expected.slice(0, 4));
  return expected.slice(5, 7) === '12' ? year : year - 1;
}

function cachedMonthsOf(year) {
  const one = store.readYear(year);
  return Object.keys((one && one.months) || {}).sort();
}

function latestCachedMonth() {
  return store.stats().latest;
}

/** 某些年份上游本来就没有页面（早于站点最早年份）：记住，别每次打开都重试 */
function missingYear(error) {
  return !!(error && error.noYear);
}

/** 把 [fromYear, toYear] 的住户存款补进缓存（失败只记录，不抛错） */
async function ensureYears(fromYear, toYear, opts) {
  const o = opts || {};
  const expected = expectedMonth();
  const result = { fetched: 0, years: [], errors: [], pending: 0 };

  for (let y = Number(fromYear); y <= Number(toYear); y += 1) {
    const year = String(y);
    const decision = policy.shouldFetchYear({
      year: year,
      cachedMonths: cachedMonthsOf(year),
      expected: expected,
      force: o.force,
    });
    if (!decision.fetch) continue;

    const meta = store.readMeta();
    const yMeta = (meta.years && meta.years[year]) || {};
    // 上游本来就没有的年份：只记一次，之后不再打扰
    if (yMeta.noYear) continue;
    // 距上次回源不足 10 分钟：直接用缓存（落盘，进程重启后仍生效）
    if (!o.force && yMeta.lastAttempt && Date.now() - Date.parse(yMeta.lastAttempt) < policy.TRY_INTERVAL_MS) {
      continue;
    }
    if (o.dryRun) {
      result.pending += 1;
      continue;
    }
    if (blocked('dep:' + year, policy.COOLDOWN_MS)) continue;

    mark('dep:' + year);
    meta.years = meta.years || {};
    meta.years[year] = Object.assign({}, yMeta, { lastAttempt: new Date().toISOString() });
    store.writeMeta(meta);

    try {
      const got = await source.fetchYear(year);
      // 合并而不是覆盖：补历史缺月份时别把已缓存的月份冲掉
      const prev = store.readYear(year);
      const months = Object.assign({}, (prev && prev.months) || {}, got.months);
      store.writeYear(year, { months: months, source: got.source, fetchedAt: got.source.fetchedAt });
      result.fetched += 1;
      result.years.push(year);

      const after = store.readMeta();
      after.years = after.years || {};
      after.years[year] = Object.assign({}, after.years[year] || {}, {
        lastSuccess: new Date().toISOString(),
        lastError: null,
        latestMonth: year + '-' + Object.keys(months).sort().pop(),
        source: got.source.url,
      });
      store.writeMeta(after);
    } catch (e) {
      const after = store.readMeta();
      after.years = after.years || {};
      after.years[year] = Object.assign({}, after.years[year] || {}, {
        lastError: e.message,
        noYear: missingYear(e),
      });
      store.writeMeta(after);
      // 上游还没这个年份页不是故障（比如站点只提供到去年），不往 errors 里塞
      if (!missingYear(e)) result.errors.push(year + ' 年：' + e.message);
    }
  }

  return result;
}

function populationYears() {
  const pop = store.readPopulation();
  return {
    years: (pop && pop.years) || {},
    coverageFrom: pop && pop.coverageFrom ? Number(pop.coverageFrom) : 0,
    error: '',
  };
}

/** 补人口分母（覆盖 2015 起；上游缺的年份记住下界，避免反复重试） */
async function ensurePopulation(fromYear, toYear, opts) {
  const o = opts || {};
  const current = populationYears();
  const meta = store.readMeta();
  const pMeta = meta.population || {};

  const missing = [];
  for (let y = Number(fromYear); y <= Number(toYear); y += 1) {
    const year = String(y);
    if (current.years[year]) continue;
    // 上游最早只到 2016：已知下界之前不再当缺失
    if (current.coverageFrom && y < current.coverageFrom) continue;
    missing.push(year);
  }
  if (!missing.length) return { fetched: false, reason: '已覆盖', pending: 0, errors: [] };
  if (!o.force && pMeta.lastAttempt && Date.now() - Date.parse(pMeta.lastAttempt) < policy.TRY_INTERVAL_MS) {
    return { fetched: false, reason: '距上次回源不足 10 分钟', pending: 0, errors: [] };
  }
  if (o.dryRun) return { fetched: false, pending: 1, errors: [] };
  if (blocked('dep:pop', policy.COOLDOWN_MS)) return { fetched: false, reason: '冷却中', pending: 0, errors: [] };

  mark('dep:pop');
  meta.population = Object.assign({}, pMeta, { lastAttempt: new Date().toISOString() });
  store.writeMeta(meta);

  try {
    const got = await source.fetchPopulation(fromYear, toYear);
    const merged = Object.assign({}, current.years, got.years);
    const keys = Object.keys(merged).sort();
    store.writePopulation({
      years: merged,
      source: got.source,
      coverageFrom: keys.length ? keys[0] : current.coverageFrom,
      fetchedAt: got.fetchedAt,
    });
    const after = store.readMeta();
    after.population = Object.assign({}, after.population || {}, {
      lastSuccess: new Date().toISOString(),
      lastError: null,
    });
    store.writeMeta(after);
    return { fetched: true, pending: 0, errors: [] };
  } catch (e) {
    const after = store.readMeta();
    after.population = Object.assign({}, after.population || {}, { lastError: e.message });
    store.writeMeta(after);
    return { fetched: false, pending: 0, errors: ['年末总人口：' + e.message] };
  }
}

/** [fromYear-1, toYear] 的住户存款索引：'YYYY-MM' → { balance, demand, time } */
function readIndex(fromYear, toYear) {
  const map = new Map();
  for (let y = Number(fromYear); y <= Number(toYear); y += 1) {
    const one = store.readYear(String(y));
    if (!one || !one.months) continue;
    Object.keys(one.months).forEach((m) => map.set(y + '-' + m, one.months[m]));
  }
  return map;
}

function balanceAt(key, index) {
  const hit = index.get(key);
  return hit && typeof hit.balance === 'number' ? hit.balance : null;
}

function rawOf(indicator, key, index, pops) {
  const from = indicator.from;
  if (from === 'balance') return balanceAt(key, index);
  if (from === 'demand' || from === 'time') {
    const hit = index.get(key);
    const v = hit ? hit[from] : null;
    return typeof v === 'number' ? v : null;
  }

  const balance = balanceAt(key, index);
  if (balance === null) return null;

  if (from === 'monthly_add') {
    const prev = balanceAt(policy.addMonths(key, -1), index);
    return prev === null ? null : balance - prev;
  }
  if (from === 'ytd_add') {
    const dec = balanceAt(String(Number(key.slice(0, 4)) - 1) + '-12', index);
    return dec === null ? null : balance - dec;
  }
  if (from === 'yoy') {
    const prev = balanceAt(String(Number(key.slice(0, 4)) - 1) + '-' + key.slice(5, 7), index);
    if (!prev) return null;
    return (balance / prev - 1) * 100;
  }
  if (from === 'per_capita') {
    // 人均只取每年 12 月：人口是年度数，月度余额除年度人口只能落在年末才干净
    if (key.slice(5, 7) !== '12') return null;
    const pop = pops[key.slice(0, 4)];
    if (!pop) return null;
    return balance / pop;
  }
  return null;
}

/** 从缓存拼序列：缺月为 null，不插值 */
function points(indicator, from, to) {
  const fromY = Number(from.slice(0, 4));
  const toY = Number(to.slice(0, 4));
  const index = readIndex(fromY - 1, toY);
  const pops = populationYears().years;
  return monthSpan(from, to).map((key) => {
    const hit = index.get(key);
    const raw = rawOf(indicator, key, index, pops);
    return {
      month: key,
      raw: raw,
      value: toValue(indicator, raw),
      source: hit ? 'pbc' : null,
    };
  });
}

/** 该指标最新一个「有值」的月份 */
function latestMonthOf(indicator) {
  const stats = store.stats();
  if (indicator.from !== 'per_capita') return stats.latest;
  const years = store.listYears().slice().reverse();
  for (const year of years) {
    const months = cachedMonthsOf(year);
    if (!months.length || months.indexOf('12') === -1) continue;
    const balance = balanceAt(year + '-12', readIndex(year, year));
    if (balance === null) continue;
    if (populationYears().years[year]) return year + '-12';
  }
  return '';
}

/** 最近一次回源错误（按年 + 人口）；上游本来就没有的年份不算错误 */
function lastErrorOf() {
  const meta = store.readMeta();
  const errors = [];
  Object.keys(meta.years || {}).forEach((year) => {
    const one = meta.years[year] || {};
    if (one.lastError && !one.noYear) errors.push(year + ' 年：' + one.lastError);
  });
  if (meta.population && meta.population.lastError) errors.push('年末总人口：' + meta.population.lastError);
  return errors;
}

function descriptor(indicator) {
  const history = config.historyRange();
  const expected = expectedMonth();
  const latest = latestMonthOf(indicator);
  const errors = lastErrorOf();
  const meta = store.readMeta();
  const latestYearMeta = latest ? (meta.years || {})[latest.slice(0, 4)] || {} : {};
  const staleMonth = indicator.from === 'per_capita'
    ? latest < String(populationTargetYear()) + '-12'
    : !latest || latest < expected;

  return {
    id: indicator.id,
    label: indicator.label,
    shortLabel: indicator.shortLabel || indicator.label,
    unit: indicator.unit,
    kind: indicator.kind,
    group: indicator.group || '',
    decimals: decimalsOf(indicator),
    note: indicator.note || '',
    historyFrom: history.from + '-01',
    expectedLatest: expected,
    latestCached: latest,
    stale: staleMonth || errors.length > 0,
    source: latest ? 'pbc' : '',
    lastError: errors[0] || '',
    lastSuccess: latestYearMeta.lastSuccess || '',
    // 计算口径：前端图注直接显示，避免把差分值当成官方发布值
    computed: ['monthly_add', 'ytd_add', 'yoy', 'per_capita'].indexOf(indicator.from) !== -1,
  };
}

/** 单指标：先 ensure 再取数 */
async function getSeries(id, opts) {
  const o = opts || {};
  const indicator = config.byId(id);
  const history = config.historyRange();
  const from = o.from || history.from + '-01';
  const to = o.to || expectedMonth();

  const r = await ensureYears(Number(from.slice(0, 4)) - 1, Number(to.slice(0, 4)), { force: o.force });
  if (indicator.from === 'per_capita') {
    const p = await ensurePopulation(Number(from.slice(0, 4)), populationTargetYear(), {});
    if (p.errors && p.errors.length) r.errors = (r.errors || []).concat(p.errors);
  }

  const pts = points(indicator, from, to);
  const desc = descriptor(indicator);
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

/** 后台补拉：同一年份只跑一份，不重复堆任务 */
const bgJobs = new Map();

function refreshInBackground(fromYear, toYear) {
  const key = fromYear + '|' + toYear;
  if (bgJobs.has(key)) return;
  const job = (async () => {
    await ensureYears(fromYear, toYear, { force: false });
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
  const from = o.from || history.from + '-01';
  const to = o.to || expectedMonth();
  const expected = expectedMonth();
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));

  const startedAt = Date.now();
  const stats = store.stats();
  const latest = stats.latest;
  const lag = latest ? monthSpan(latest < expected ? latest : expected, expected).length - 1 : 99;
  const cold = !stats.months;

  // 首次运行整段拉全；落后 3 期以上同步补齐；其余交给后台
  const sync = cold || lag >= 3;
  let fetched = 0;
  let errors = [];
  if (cold || o.force) {
    const r = await ensureYears(history.from, toYear, { force: o.force });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  } else if (sync) {
    const r = await ensureYears(Number(latest.slice(0, 4)), toYear, { force: false });
    fetched = r.fetched;
    errors = errors.concat(r.errors || []);
  }

  const pop = await ensurePopulation(fromYear, populationTargetYear(), {});
  errors = errors.concat(pop.errors || []);

  const indicators = config.list();
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

  // 后台核对：只有落后应发布月份时才发起，首屏不等它
  let refreshing = 0;
  if (!o.force && !cold) {
    const nextLag = latest ? monthSpan(latest < expected ? latest : expected, expected).length - 1 : 99;
    if (nextLag > 0) {
      const probe = await ensureYears(Number((latest || from).slice(0, 4)), toYear, { dryRun: true });
      if (probe.pending) {
        refreshing = probe.pending;
        refreshInBackground(Number((latest || from).slice(0, 4)), toYear);
      } else if (bgJobs.size) {
        refreshing = bgJobs.size;
      }
    }
  }

  const settings = config.settings();
  return {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range: { from: from, to: to },
    history: { from: history.from + '-01', to: '' },
    expectedLatest: expected,
    latestMonth: latestCachedMonth(),
    fetched: fetched,
    refreshing: refreshing,
    errors: errors,
    stale: items.some((x) => x.stale) || errors.length > 0,
    groups: settings.groups,
    population: {
      label: (settings.population && settings.population.label) || '年末总人口（万人）',
      source: (settings.population && settings.population.source) || '',
      years: populationYears().years,
    },
    source: settings.source,
    indicators: items,
    firstRun: cold,
    cache: store.stats(),
  };
}

/** 数据集概况：只读本地文件，不回源，供启动日志与健康检查使用 */
function datasetStatus() {
  const stats = store.stats();
  const expected = expectedMonth();
  const behind = !stats.latest || stats.latest < expected ? 1 : 0;
  return {
    dir: stats.dir,
    files: stats.years,
    months: stats.months,
    populationYears: stats.populationYears,
    historyFrom: config.historyRange().from + '-01',
    latest: stats.latest,
    expected: expected,
    behind: behind,
  };
}

module.exports = {
  ensureYears,
  ensurePopulation,
  points,
  descriptor,
  getSeries,
  overview,
  datasetStatus,
  toValue,
  monthSpan,
  expectedMonth,
};
