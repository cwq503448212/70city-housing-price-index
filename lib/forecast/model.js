'use strict';

/**
 * 人口与住房推演模型（纯函数，不碰磁盘、不发请求）
 *
 * 输入：官方原值序列 { 指标id: { 年份: 数值 } }
 * 输出：历史线 + 三情景未来线 + 校准系数 + 回测误差
 *
 * 方法（全部写进 config/forecast.json 的 model 段，改参数即改结论）：
 *   1. 出生人口 = 出生率 × 年平均人口 ÷ 1000（官方只发千分率）
 *   2. 各学段招生 = 上游队列 × 近 N 年传导系数
 *        出生 → 小学（滞后 6 年）→ 初中（6 年）→ 普高（3 年）→ 本专科（3 年）
 *   3. 在校生 = 最近「学制」年招生按权重加总（本专科 4 年权重 0.75 近似 3/4 年混合）
 *   4. 购房主力人口 = 25—44 岁出生队列 × 存活率
 *   5. 销售面积 = 购房主力人口 × 人均购房强度，强度按情景向目标值指数收敛
 *   6. 商品房均价 = 官方最新均价 × (1 + 名义年增速)^年数
 *
 * 三条硬规矩：
 *   - 历史年份一律用官方值（招生 / 在校生 / 面积 / 均价），绝不用模型值覆盖
 *   - 任一输入缺失就返回 null，不插值、不补 0
 *   - 推演值只在「官方没有的年份」出现，且返回结构上与 actual 分开
 */

const config = require('./config');

function yearList(from, to) {
  const out = [];
  for (let y = Number(from); y <= Number(to) && out.length < 300; y += 1) out.push(String(y));
  return out;
}

function round(x, d) {
  if (x === null || x === undefined || !isFinite(x)) return null;
  const f = Math.pow(10, d === undefined ? 1 : d);
  return Math.round(x * f) / f;
}

function mean(list) {
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function valueOf(series, year) {
  const v = series ? series[year] : null;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function latestYearOf(series) {
  const years = Object.keys(series || {}).filter((y) => valueOf(series, y) !== null).sort();
  return years.length ? years[years.length - 1] : '';
}

/** 出生人口：率（‰）× 年平均人口（万人）÷ 1000 */
function birthSeries(rateByYear, popByYear, from, to) {
  const out = {};
  yearList(from, to).forEach((y) => {
    const r = valueOf(rateByYear, y);
    const p1 = valueOf(popByYear, String(Number(y) - 1));
    const p2 = valueOf(popByYear, y);
    out[y] = r === null || p1 === null || p2 === null ? null : (r / 1000) * ((p1 + p2) / 2);
  });
  return out;
}

/**
 * 招生传导系数：actual(y) ÷ upstream(y - lag)，取最近 n 个有效年做算术平均
 * @returns {{ratio:number|null, samples:Array, n:number}}
 */
function calibrate(actual, upstream, lag, n, endYear) {
  const samples = [];
  const start = Number(endYear);
  for (let y = start; y >= start - 40 && samples.length < n; y -= 1) {
    const a = valueOf(actual, String(y));
    const u = valueOf(upstream, String(y - lag));
    if (a === null || u === null || u === 0) continue;
    samples.push({ year: String(y), ratio: a / u });
  }
  return {
    ratio: mean(samples.map((s) => s.ratio)),
    samples,
    n: samples.length,
  };
}

/** 把 { 年份: 值 } 转成 [{year, value}]，只保留给定年份 */
function pointsOf(series, years) {
  return years.map((year) => ({ year: year, value: round(valueOf(series, year), 1) }));
}

/**
 * 主入口
 * @param {Object} raw { 指标id: { 年份: 数值 } }
 * @param {Object} opts { from, horizon }
 */
function build(raw, opts) {
  const o = opts || {};
  const model = config.model();
  const stagesCfg = model.stages || {};
  const stageKeys = Object.keys(stagesCfg);
  const housing = model.housing || {};
  const scenariosCfg = model.scenarios || {};
  const backtestCfg = model.backtest || {};
  const historyFrom = o.from || config.historyRange().from;
  const horizon = String(o.horizon || model.horizon || '2055');

  const birth = birthSeries(raw.birth_rate, raw.total_population, historyFrom, horizon);
  const latestBirth = latestYearOf(birth);

  // 情景出生：以最新一年官方出生人口为起点，按年增速外推。
  // 不用「近 N 年均值」作起点：那会让 2026 年比 2025 年凭空跳高一段，
  // 图上的历史实线与情景虚线就接不上，也会误导读者以为模型预期出生反弹。
  const latestBirthValue = valueOf(birth, latestBirth);
  const birthBase = latestBirthValue;
  const baseYear = Number(latestBirth);

  function futureBirth(scenario, year) {
    if (birthBase === null) return null;
    return birthBase * Math.pow(1 + Number(scenario.birthGrowth || 0), Number(year) - baseYear);
  }

  /**
   * 某个学段某年的招生：
   *   历史有官方值 → 官方值
   *   否则 = 上游队列 × 传导系数（上游同样递归：可以一路回到已出生人口）
   */
  function admitAt(scenario, stage, year, calibration) {
    const actual = raw[stagesCfg[stage].admit] || {};
    const hit = valueOf(actual, String(year));
    if (hit !== null) return hit;

    const upYear = String(Number(year) - Number(stagesCfg[stage].lag));
    let upstreamVal;
    if (stagesCfg[stage].upstream === 'birth') {
      upstreamVal = Number(upYear) > baseYear ? futureBirth(scenario, upYear) : valueOf(birth, upYear);
    } else {
      upstreamVal = admitAt(scenario, stagesCfg[stage].upstream, upYear, calibration);
    }
    const ratio = calibration[stage] ? calibration[stage].ratio : null;
    if (upstreamVal === null || ratio === null) return null;
    return upstreamVal * ratio;
  }

  /** 在校生：历史用官方值，未来用最近「学制」年招生按权重加总 */
  function enrollAt(scenario, stage, year, calibration) {
    const actual = raw[stagesCfg[stage].enroll] || {};
    const hit = valueOf(actual, String(year));
    if (hit !== null) return hit;

    const weights = stagesCfg[stage].weights || [];
    let sum = 0;
    for (let k = 0; k < weights.length; k += 1) {
      const v = admitAt(scenario, stage, String(Number(year) - k), calibration);
      if (v === null) return null;
      sum += v * weights[k];
    }
    return sum;
  }

  /** 购房主力人口：25—44 岁出生队列逐年移位（缺任一年就 null，不插值） */
  function buyerPopAt(scenario, year) {
    const from = Number(housing.buyerAgeFrom);
    const to = Number(housing.buyerAgeTo);
    const survival = Number(housing.survival || 1);
    let sum = 0;
    for (let age = from; age <= to; age += 1) {
      const by = String(Number(year) - age);
      const v = Number(by) > baseYear ? futureBirth(scenario, by) : valueOf(birth, by);
      if (v === null) return null;
      sum += v;
    }
    return sum * survival;
  }

  // 校准系数（基准情景与情景无关：系数来自历史，不随情景变）
  const calibEnd = latestBirth;
  const calibration = {};
  stageKeys.forEach((key) => {
    const s = stagesCfg[key];
    const upstream =
      s.upstream === 'birth' ? birth : raw[stagesCfg[s.upstream].admit] || {};
    calibration[key] = calibrate(
      raw[s.admit] || {},
      upstream,
      Number(s.lag),
      Number(model.calibrationYears || 5),
      calibEnd
    );
    calibration[key].label = s.label;
  });

  // 历史区间：出生从历史起点，教育与房产从各自首个有效年；统一裁到 2000 年之后，
  // 让四张图和一张表共用同一根时间轴（人口出生队列本身仍然从 1978 起算）
  const chartFrom = o.chartFrom || '2000';
  const historyYears = yearList(chartFrom, latestBirth);
  const futureYears = yearList(String(baseYear + 1), horizon);

  const scenarios = {};
  ['low', 'base', 'high'].forEach((key) => {
    const sc = scenariosCfg[key];
    if (!sc) return;
    const stageOut = {};
    stageKeys.forEach((k) => {
      stageOut[k] = {
        label: stagesCfg[k].label,
        years: Number(stagesCfg[k].years),
        admit: pointsOf(
          futureYears.reduce((acc, y) => {
            acc[y] = admitAt(sc, k, y, calibration);
            return acc;
          }, {}),
          futureYears
        ),
        enroll: pointsOf(
          futureYears.reduce((acc, y) => {
            acc[y] = enrollAt(sc, k, y, calibration);
            return acc;
          }, {}),
          futureYears
        ),
      };
    });

    const buyer = futureYears.reduce((acc, y) => {
      acc[y] = buyerPopAt(sc, y);
      return acc;
    }, {});

    // 销售面积：以最新有官方面积的年份为锚，人均强度按情景向目标值指数收敛
    const anchorYear = latestYearOf(raw.sales_area);
    const anchorPop = anchorYear ? buyerPopAt(sc, anchorYear) : null;
    const anchorArea = valueOf(raw.sales_area, anchorYear);
    const h0 = anchorPop && anchorArea ? anchorArea / anchorPop : null;
    const target = Number(sc.houseIntensity === undefined ? 1 : sc.houseIntensity);
    const tau = Number(housing.intensityTau || 8);
    const area = futureYears.reduce((acc, y) => {
      const pop = buyer[y];
      if (pop === null || h0 === null) {
        acc[y] = null;
        return acc;
      }
      const f = target + (1 - target) * Math.exp(-(Number(y) - Number(anchorYear)) / tau);
      acc[y] = pop * h0 * f;
      return acc;
    }, {});

    // 均价：官方最新年均价 × (1 + 名义增速)^年数（不扣通胀）
    const priceYear = latestYearOf(raw.price);
    const p0 = valueOf(raw.price, priceYear);
    const g = Number(sc.priceGrowth || 0);
    const price = futureYears.reduce((acc, y) => {
      acc[y] = p0 === null ? null : p0 * Math.pow(1 + g, Number(y) - Number(priceYear));
      return acc;
    }, {});

    scenarios[key] = {
      key: key,
      label: sc.label,
      birthGrowth: Number(sc.birthGrowth || 0),
      houseIntensity: target,
      priceGrowth: g,
      birth: pointsOf(
        futureYears.reduce((acc, y) => {
          acc[y] = futureBirth(sc, y);
          return acc;
        }, {}),
        futureYears
      ),
      stages: stageOut,
      buyerPop: pointsOf(buyer, futureYears),
      salesArea: pointsOf(area, futureYears),
      price: pointsOf(price, futureYears),
    };
  });

  // 历史实际（统一时间轴）
  const actual = {
    birth: pointsOf(birth, historyYears),
    buyerPop: pointsOf(
      historyYears.reduce((acc, y) => {
        acc[y] = buyerPopAt(scenariosCfg.base, y);
        return acc;
      }, {}),
      historyYears
    ),
    salesArea: pointsOf(raw.sales_area || {}, historyYears),
    price: pointsOf(raw.price || {}, historyYears),
    stages: {},
  };
  stageKeys.forEach((k) => {
    actual.stages[k] = {
      label: stagesCfg[k].label,
      admit: pointsOf(raw[stagesCfg[k].admit] || {}, historyYears),
      enroll: pointsOf(raw[stagesCfg[k].enroll] || {}, historyYears),
    };
  });

  // 回测：用历史窗口校准系数，滚动预测 2020—2025 的招生，与实际比
  const backtest = {
    from: String(backtestCfg.from || '2020'),
    to: String(backtestCfg.to || latestBirth),
    stages: {},
  };
  const btYears = yearList(backtest.from, backtest.to);
  stageKeys.forEach((key) => {
    const s = stagesCfg[key];
    const upstream =
      s.upstream === 'birth' ? birth : raw[stagesCfg[s.upstream].admit] || {};
    const cal = calibrate(
      raw[s.admit] || {},
      upstream,
      Number(s.lag),
      Number(backtestCfg.calibrateTo || 2019) - Number(backtestCfg.calibrateFrom || 2015) + 1,
      backtestCfg.calibrateTo || '2019'
    );
    const pts = btYears.map((y) => {
      const up = valueOf(upstream, String(Number(y) - Number(s.lag)));
      const act = valueOf(raw[s.admit] || {}, y);
      const pred = up === null || cal.ratio === null ? null : up * cal.ratio;
      return {
        year: y,
        actual: round(act, 1),
        forecast: round(pred, 1),
        error: act && pred !== null ? (pred - act) / act : null,
      };
    });
    const valid = pts.filter((p) => p.error !== null);
    backtest.stages[key] = {
      label: s.label,
      ratio: round(cal.ratio, 3),
      samples: cal.samples,
      mape: valid.length ? mean(valid.map((p) => Math.abs(p.error))) : null,
      points: pts,
    };
  });

  // KPI：取基准情景
  const base = scenarios.base || scenarios.low || scenarios.high;
  function at(scenario, path, year) {
    if (!scenario) return null;
    const arr = path.split('.').reduce((obj, key) => (obj ? obj[key] : null), scenario);
    if (!arr) return null;
    const hit = arr.filter((p) => p.year === String(year))[0];
    return hit ? hit.value : null;
  }
  function latestPoint(list) {
    const valid = (list || []).filter((p) => p.value !== null);
    return valid.length ? valid[valid.length - 1] : null;
  }
  function peakYear(list) {
    let best = null;
    (list || []).forEach((p) => {
      if (p.value === null) return;
      if (!best || p.value > best.value) best = p;
    });
    return best;
  }

  // 本轮周期的小学在校生峰值：只看近 10 年（含基准推演），不拿 2000 年的
  // 1.3 亿历史高位当「峰值」——那一段是另一轮学龄人口周期，与本轮无关
  const peakWindowFrom = String(Number(latestBirth) - 10);
  const primaryAll = (actual.stages.primary.enroll || [])
    .filter((p) => p.year >= peakWindowFrom)
    .concat(base && base.stages.primary ? base.stages.primary.enroll : []);
  const primaryPeak = peakYear(primaryAll);

  const kpi = [
    { id: 'birth', label: '最新出生人口', year: latestBirth, value: round(valueOf(birth, latestBirth), 1), unit: '万人', computed: true },
    {
      id: 'primary_peak',
      label: '本轮小学在校生峰值',
      year: primaryPeak ? primaryPeak.year : '',
      value: primaryPeak ? primaryPeak.value : null,
      unit: '万人',
      note: '近 10 年实际与基准推演合并后的最高点',
    },
    { id: 'primary_2030', label: '小学在校生 2030', year: '2030', value: at(base, 'stages.primary.enroll', '2030'), unit: '万人' },
    { id: 'junior_2035', label: '初中在校生 2035', year: '2035', value: at(base, 'stages.junior.enroll', '2035'), unit: '万人' },
    { id: 'senior_2040', label: '普高在校生 2040', year: '2040', value: at(base, 'stages.senior.enroll', '2040'), unit: '万人' },
    { id: 'college_2045', label: '本专科在校生 2045', year: '2045', value: at(base, 'stages.college.enroll', '2045'), unit: '万人' },
    { id: 'buyer_2025', label: '购房主力人口 2025', year: '2025', value: actual.buyerPop.filter((p) => p.year === '2025')[0] ? actual.buyerPop.filter((p) => p.year === '2025')[0].value : null, unit: '万人' },
    { id: 'sales_2050', label: '销售面积 2050（基准）', year: '2050', value: at(base, 'salesArea', '2050'), unit: '万㎡' },
  ];

  return {
    horizon: horizon,
    baseYear: latestBirth,
    chartFrom: chartFrom,
    years: { history: historyYears, future: futureYears },
    actual: actual,
    scenarios: scenarios,
    calibration: Object.keys(calibration).map((k) => ({
      stage: k,
      label: calibration[k].label,
      upstream: stagesCfg[k].upstream,
      lag: Number(stagesCfg[k].lag),
      years: Number(stagesCfg[k].years),
      ratio: round(calibration[k].ratio, 3),
      n: calibration[k].n,
      samples: calibration[k].samples.map((s) => ({ year: s.year, ratio: round(s.ratio, 3) })),
    })),
    backtest: backtest,
    backtestWindow: {
      calibrateFrom: String(backtestCfg.calibrateFrom || '2015'),
      calibrateTo: String(backtestCfg.calibrateTo || '2019'),
      from: String(backtestCfg.from || '2020'),
      to: String(backtestCfg.to || latestBirth),
    },
    kpi: kpi,
    params: {
      birthBase: round(birthBase, 1),
      birthBaseYears: 1,
      baseYear: baseYear,
      calibrationYears: Number(model.calibrationYears || 5),
      buyerAgeFrom: Number(housing.buyerAgeFrom),
      buyerAgeTo: Number(housing.buyerAgeTo),
      survival: Number(housing.survival),
      intensityTau: Number(housing.intensityTau),
      anchorYear: latestYearOf(raw.sales_area),
      priceYear: latestYearOf(raw.price),
      h0: (function () {
        const y = latestYearOf(raw.sales_area);
        const p = y ? buyerPopAt(scenariosCfg.base, y) : null;
        const a = valueOf(raw.sales_area, y);
        return p && a ? round(a / p, 3) : null;
      })(),
      notes: model.notes || [],
    },
  };
}

module.exports = { build, birthSeries, calibrate, yearList };
