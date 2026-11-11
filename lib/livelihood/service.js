'use strict';

/**
 * 民生（人口与婚育）序列服务：缓存优先——首次运行一次拉全历史，之后只补新落下的年度
 *
 * 对外动作与宏观模块一致：
 *   ensure(indicator, {from,to,force})  按策略判断是否要拉，拉完写缓存
 *   points(indicator, from, to)         从缓存拼出按年序列（缺年补 null）
 *   overview({from,to,force})           一次性给前端全部指标
 *
 * 远端按「栏目」批量取数：同一年度库栏目一次请求可带多个指标，
 * 16 个原值指标只落在 4 个栏目里，所以一次首屏最多 4 个请求。
 *
 * 落盘的只有上游原值（万人 / 万对 / ‰ / 岁 / %）；下面四个量是现算的，不落盘、不回源：
 *   出生人口 = 出生率（‰）× 年平均人口（万人）÷ 1000
 *   死亡人口 = 死亡率（‰）× 年平均人口（万人）÷ 1000
 *   自然增长量 = 出生人口 − 死亡人口
 *   生死比 = 出生人口 ÷ 死亡人口
 * 年平均人口 =（上年末总人口 + 本年末总人口）÷ 2。年度库只发布千分率、不发布出生 / 死亡
 * 人口绝对数，所以只能按官方定义还原；公式改了不用清缓存，口径也不会新旧混在一起。
 */

const config = require('./config');
const store = require('./store');
const policy = require('./policy');
const nbs = require('./source');
const { blocked, mark } = require('./queue');

/** 年度序列：['2019','2020', ...] 含首尾 */
function yearRange(from, to) {
  const out = [];
  for (let y = Number(from); y <= Number(to) && out.length < 200; y += 1) out.push(String(y));
  return out;
}

/** 原值 / 计算值 → 展示值（按指标自己的小数位取整） */
function toValue(indicator, raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return null;
  const f = Math.pow(10, decimalsOf(indicator));
  return Math.round(raw * f) / f;
}

function decimalsOf(indicator) {
  return typeof indicator.decimals === 'number' ? indicator.decimals : 2;
}

/** 计算量的浮点噪声（如 0.1 + 0.2）裁到 4 位小数，再由 toValue 按 decimals 取整 */
function clean(x) {
  return Math.round(x * 10000) / 10000;
}

function prevYearOf(year) {
  return String(Number(year) - 1);
}

/**
 * 单年取值：原值读缓存，计算量现算（缺任一输入就是缺失，不补 0）
 *   rate_count  千分率 × 年平均人口 ÷ 1000（出生 / 死亡人口）
 *   diff / ratio 两个输入逐项相减 / 相除
 */
function valueAt(indicator, year) {
  if (!indicator.derive) {
    const hit = store.readYear(indicator.id, year);
    return hit && typeof hit.raw === 'number' ? hit.raw : null;
  }

  const a = valueAt(config.byId(indicator.inputs[0]), year);
  const b = valueAt(config.byId(indicator.inputs[1]), year);

  if (indicator.derive === 'rate_count') {
    // 分母是年平均人口 =（上年末 + 本年末）÷ 2：历史起点当年没有上年人口，返回 null
    const p0 = valueAt(config.byId(indicator.inputs[1]), prevYearOf(year));
    if (a === null || b === null || p0 === null) return null;
    return clean((a / 1000) * ((p0 + b) / 2));
  }

  if (a === null || b === null) return null;
  if (indicator.derive === 'diff') return clean(a - b);
  if (indicator.derive === 'ratio') return b === 0 ? null : clean(a / b);
  return null;
}

/** 计算量的最新有效年度：从应发布年度往回找第一个有值的年 */
function latestComputedYear(indicator) {
  const from = config.historyRange().from;
  for (let y = Number(policy.expectedLatestYear(new Date())); y >= Number(from); y -= 1) {
    if (valueAt(indicator, String(y)) !== null) return String(y);
  }
  return '';
}

/** 计算量的 stale 跟着输入指标走：任一输入滞后或回源失败就算滞后 */
function inputsStale(indicator) {
  return (indicator.inputs || []).some((id) => {
    const dep = config.byId(id);
    if (!dep) return true;
    if (dep.derive) return inputsStale(dep);
    const years = store.listYears(dep.id);
    const latest = years.length ? years[years.length - 1] : '';
    const meta = store.readMeta(dep.id) || {};
    const expected = dep.until || policy.expectedLatestYear(new Date());
    return !latest || latest < expected || !!meta.lastError;
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
      // 只给「最新有效年份之前」的空洞落 null 占位：人口分段 1983—1986、1988—1989
      // 这类官方本来就没有的年份，不落盘会被 policy 当成「还没缓存」，每次打开都
      // 对同一份数据反复回源。
      // 最新有效年份之后的缺口不落占位：那通常是「还没发布」（如婚姻登记 2025），
      // 落了会把「待更新」伪装成「已核对」
      const valueYears = Object.keys(map).filter((y) => y >= from && y <= to).sort();
      if (valueYears.length) {
        const lastWithValue = valueYears[valueYears.length - 1];
        const cachedYears = new Set(store.listYears(m.id));
        for (let y = Number(from); y <= Number(lastWithValue); y += 1) {
          const key = String(y);
          if (cachedYears.has(key) || Object.prototype.hasOwnProperty.call(map, key)) continue;
          store.writeYear(m.id, key, { raw: null, source: 'nbs', fetchedAt });
        }
      }
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
  // until：官方停更的指标（预期寿命止于 2020）只核到那一年，不算滞后，force 也不回源
  const cap = indicator.until && indicator.until < expectedLatest ? indicator.until : expectedLatest;
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < cap ? o.to : cap;
  if (from > to) return { fetched: false, reason: '区间为空' };

  const cached = store.listYears(indicator.id);
  const decision = policy.shouldFetch({
    cachedYears: cached,
    wantFrom: from,
    until: indicator.until,
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
  const cached = indicator.derive ? [] : store.listYears(indicator.id);
  const meta = indicator.derive ? {} : store.readMeta(indicator.id) || {};
  // 归档序列的「应发布年度」就是它停更的那一年，拿当年去比会永远显示滞后
  const expectedLatest = indicator.until || policy.expectedLatestYear(new Date());
  const latestCached = indicator.derive
    ? latestComputedYear(indicator)
    : cached.length
      ? cached[cached.length - 1]
      : '';
  const stale = indicator.derive
    ? inputsStale(indicator)
    : !latestCached || latestCached < expectedLatest || !!meta.lastError;
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
    stale: stale,
    // 计算量：前端图注与明细表必须标「计算值」，不能当成官方发布值
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
  const expectedLatest = policy.expectedLatestYear(new Date());
  const from = o.from && o.from > history.from ? o.from : history.from;
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;

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
  // 原值指标才需要回源；计算量（出生 / 死亡人口等）没有缓存目录，参与分类会永远被当成 cold
  const indicators = config.list();
  const fetchable = indicators.filter((ind) => !ind.derive);
  const expectedLatest = expectedLatestOf();
  const to = o.to && o.to < expectedLatest ? o.to : expectedLatest;
  const from = o.from && o.from > history.from ? o.from : history.from;

  const startedAt = Date.now();
  let fetchedCount = 0;
  const errors = [];

  // 与宏观模块同款四分类：
  //   cold   —— 一个年度缓存都没有：首次运行，按全历史整段拉全，不受当前展示区间限制
  //   empty  —— 有缓存但当前区间是空的：等一下上游，否则首屏只能是空曲线
  //   behind —— 落后应发布年度 2 年以上（比如包放了几年才打开）：同步补齐再渲染
  //   warm   —— 有缓存且基本跟上：先用缓存出图，只在「应发布年度还没落缓存」时后台核对
  const warm = [];
  const empty = [];
  const behind = [];
  const cold = [];
  indicators.forEach((ind) => {
    if (ind.derive) return;
    const years = store.listYears(ind.id);
    // 归档指标（until）按它自己的停更年份算，否则永远落在 behind 里，每次打开都同步补一轮
    const cap = ind.until && ind.until < expectedLatest ? ind.until : expectedLatest;
    const behindCutoff = String(Number(cap) - 2);
    if (!years.length) cold.push(ind);
    else if (!years.some((y) => y >= from && y <= to)) empty.push(ind);
    else if (years[years.length - 1] < behindCutoff) behind.push(ind);
    else warm.push(ind);
  });

  for (const indicator of o.force ? fetchable : cold.concat(empty, behind)) {
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
  const expectedLatest = expectedLatestOf();
  config.list().forEach((indicator) => {
    if (indicator.derive) return; // 计算量没有独立缓存，滞后由输入指标体现
    const years = store.listYears(indicator.id);
    const last = years.length ? years[years.length - 1] : '';
    // 归档指标按 until 判定，否则永远被算成「落后」（预期寿命止于 2020）
    const cap = indicator.until && indicator.until < expectedLatest ? indicator.until : expectedLatest;
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

module.exports = { ensure, points, descriptor, getSeries, overview, datasetStatus, toValue, yearRange };
