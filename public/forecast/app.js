'use strict';

/**
 * 人口与住房推演 —— 前端渲染
 *
 * 数据只有一次请求：/api/forecast
 *   历史段：官方年度发布值（教育 / 人口 / 房地产 7 个栏目）
 *   推演段：model.scenarios 里 low / base / high 三套情景，2026 年起
 *
 * 口径铁律（与页脚一致，改前端别改口径）：
 *   - 2026 年及以后全是本页推演值，图上虚线、表里标「推演」，绝不与官方值混成一条实线；
 *   - 出生人口 = 出生率 × 年平均人口，是还原值，标签写「计算」；
 *   - 购房主力人口、销售面积、均价都是模型输出，不冒称官方数据；
 *   - 缺失就是 null，画成空点，不插值、不补 0；
 *   - 历史段永远用官方值，模型值不覆盖历史。
 */

(function () {
  const API = '/api/forecast';

  // 学段顺序固定：小学 → 初中 → 普高 → 本专科（与配置里的队列顺序一致）
  const STAGES = [
    { key: 'primary', label: '小学', short: '小学', color: '#175cd3' },
    { key: 'junior', label: '初中', short: '初中', color: '#0e7490' },
    { key: 'senior', label: '普通高中', short: '普高', color: '#b45309' },
    { key: 'college', label: '本专科', short: '本专科', color: '#7c3aed' },
  ];

  const COLOR = {
    ink: '#16181d',
    muted: '#7b8391',
    line: '#e8eaee',
    lineStrong: '#d9dce2',
    accent: '#175cd3',
    up: '#d14343',
    down: '#1f9254',
    flat: '#98a1ae',
  };

  // 三情景配色：基准用主色，低 / 高各占一头（不用红绿——红绿在本项目表示涨跌方向）
  const SCENARIO_COLOR = {
    low: '#b45309',
    base: '#175cd3',
    high: '#7c3aed',
  };

  const CHART_IDS = ['chart-birth', 'chart-edu', 'chart-buyer', 'chart-area', 'chart-price'];

  // 改默认值时必须同时升级键名（v1 -> v2）
  const PREF_KEY = 'forecast.pref.v1';

  const state = {
    eduMetric: 'enroll',
    scenario: 'base',
    histFrom: '2000',
    hidden: {}, // 教育图上被图例关掉的学段
    data: null,
    loading: false,
    charts: {},
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    eduMetric: $('edu-metric'),
    scenario: $('scenario'),
    histFrom: $('hist-from'),
    refresh: $('refresh'),
    status: $('status'),
    rangeHint: $('range-hint'),
    kpiRow: $('kpi-row'),
    thEdu: $('th-edu'),
    thJunior: $('th-junior'),
    thSenior: $('th-senior'),
    thCollege: $('th-college'),
    scenarioTable: $('table-scenario').querySelector('tbody'),
    detailTable: $('table-detail').querySelector('tbody'),
    backtestTable: $('table-backtest').querySelector('tbody'),
    calibTable: $('table-calib').querySelector('tbody'),
    notes: $('notes'),
    footMeta: $('foot-meta'),
  };

  /* ---------------- 本地偏好 ---------------- */

  function loadPref() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (!raw) return;
      const pref = JSON.parse(raw);
      if (!pref) return;
      if (pref.eduMetric === 'enroll' || pref.eduMetric === 'admit') state.eduMetric = pref.eduMetric;
      if (['low', 'base', 'high'].indexOf(pref.scenario) >= 0) state.scenario = pref.scenario;
      if (/^\d{4}$/.test(pref.histFrom || '')) state.histFrom = pref.histFrom;
    } catch (e) {
      // 本地存的东西坏了就当没有
    }
  }

  function savePref() {
    try {
      localStorage.setItem(
        PREF_KEY,
        JSON.stringify({ eduMetric: state.eduMetric, scenario: state.scenario, histFrom: state.histFrom })
      );
    } catch (e) {
      // 隐私模式下写不了，不影响使用
    }
  }

  /* ---------------- 数值格式 ---------------- */

  /** 千分位 + 固定小数位；缺失值统一显示破折号 */
  function fmtNum(v, decimals) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const d = typeof decimals === 'number' ? decimals : 1;
    const parts = Number(v).toFixed(d).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function fmtSigned(v, decimals) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const body = fmtNum(Math.abs(v), decimals);
    if (v > 0) return '+' + body;
    if (v < 0) return '-' + body;
    return body;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function signClass(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'flat';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'flat';
  }

  function yearCn(y) {
    return y ? y + ' 年' : '—';
  }

  /* ---------------- 数据访问 ---------------- */

  function model() {
    return state.data ? state.data.model : null;
  }

  /** 横轴：历史段按「历史起点」裁，推演段全给 */
  function axisYears() {
    const m = model();
    if (!m) return [];
    return m.years.history.filter((y) => y >= state.histFrom).concat(m.years.future);
  }

  function toMap(points) {
    const map = new Map();
    (points || []).forEach((p) => {
      if (p && p.year) map.set(String(p.year), p.value);
    });
    return map;
  }

  /** 把 [{year,value}] 对齐到横轴；缺失就是 null */
  function align(points, years) {
    const map = toMap(points);
    return years.map((y) => (map.has(y) ? map.get(y) : null));
  }

  /** 推演段对齐到横轴：在 anchorYear 处补一个历史值锚点，让虚线接得上实线 */
  function alignFuture(points, years, anchorYear, anchorValue) {
    const map = toMap(points);
    return years.map((y) => {
      if (anchorYear && y === String(anchorYear) && anchorValue !== null && anchorValue !== undefined) {
        return anchorValue;
      }
      return map.has(y) ? map.get(y) : null;
    });
  }

  function lastValue(points, maxYear) {
    const list = (points || []).filter((p) => p.value !== null && (!maxYear || p.year <= String(maxYear)));
    return list.length ? list[list.length - 1].value : null;
  }

  function lastYear(points) {
    const list = (points || []).filter((p) => p.value !== null);
    return list.length ? list[list.length - 1].year : '';
  }

  /** 某情景下某学段的某口径序列 */
  function stagePoints(scenarioKey, stageKey, metric) {
    const m = model();
    if (!m) return [];
    if (scenarioKey === 'actual') {
      const s = m.actual.stages[stageKey];
      return s ? s[metric] : [];
    }
    const sc = m.scenarios[scenarioKey];
    if (!sc || !sc.stages[stageKey]) return [];
    return sc.stages[stageKey][metric];
  }

  function actualSeries(key) {
    const m = model();
    return m && m.actual[key] ? m.actual[key] : [];
  }

  function scenarioSeries(scenarioKey, key) {
    const m = model();
    const sc = m && m.scenarios[scenarioKey];
    return sc && sc[key] ? sc[key] : [];
  }

  /* ---------------- 图表基座 ---------------- */

  function chartOf(id) {
    const dom = document.getElementById(id);
    if (!dom) return null;
    if (!state.charts[id]) state.charts[id] = echarts.init(dom, null, { renderer: 'canvas' });
    return state.charts[id];
  }

  function valueAxis(formatter) {
    return {
      type: 'value',
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: formatter || ((v) => fmtNum(v, 0)) },
      splitLine: { lineStyle: { color: COLOR.line } },
    };
  }

  function baseOption(unit, digits) {
    return {
      animationDuration: 420,
      grid: { left: 8, right: 18, top: 44, bottom: 26, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: COLOR.lineStrong } },
        backgroundColor: 'rgba(22,24,29,0.92)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        padding: [8, 10],
        formatter: function (params) {
          if (!params || !params.length) return '';
          const head = '<div style="font-weight:600;margin-bottom:4px">' + esc(params[0].axisValue) + ' 年</div>';
          const rows = params
            .filter((p) => p.value !== null && p.value !== undefined && isFinite(p.value))
            .map(function (p) {
              return (
                '<div style="display:flex;justify-content:space-between;gap:16px">' +
                '<span>' + p.marker + esc(p.seriesName) + '</span>' +
                '<b>' + fmtNum(p.value, digits) + ' ' + unit + '</b></div>'
              );
            });
          return head + (rows.length ? rows.join('') : '<div style="opacity:.7">该年无数据</div>');
        },
      },
      legend: {
        top: 0,
        right: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: COLOR.muted, fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: axisYears(),
        axisLine: { lineStyle: { color: COLOR.lineStrong } },
        axisTick: { show: false },
        axisLabel: { color: COLOR.muted, fontSize: 11, hideOverlap: true },
      },
      yAxis: valueAxis(),
    };
  }

  /** 官方 / 推演 的分界线：画在最新官方年那根竖线上，配一块很淡的底色盖住推演区 */
  function boundaryMark(m) {
    return {
      silent: true,
      symbol: 'none',
      // 不写文字标签：竖线上的标签会被 ECharts 旋转成竖排，难认；分界含义交给卡片说明
      label: { show: false },
      lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
      data: [{ xAxis: String(m.baseYear) }],
    };
  }

  function futureArea(m) {
    return {
      silent: true,
      itemStyle: { color: 'rgba(23,92,211,0.035)' },
      data: [[{ xAxis: String(m.baseYear) }, { xAxis: String(m.horizon) }]],
    };
  }

  function lineSeries(name, data, color, dashed, area) {
    return {
      name: name,
      type: 'line',
      data: data,
      smooth: false,
      showSymbol: false,
      symbolSize: 6,
      connectNulls: false,
      lineStyle: { width: dashed ? 1.8 : 2.2, color: color, type: dashed ? 'dashed' : 'solid' },
      itemStyle: { color: color },
      emphasis: { focus: 'series' },
      areaStyle: area
        ? {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(23,92,211,0.16)' },
              { offset: 1, color: 'rgba(23,92,211,0.01)' },
            ]),
          }
        : undefined,
    };
  }

  /* ---------------- 图：出生人口 ---------------- */

  function renderBirth() {
    const chart = chartOf('chart-birth');
    const m = model();
    if (!chart || !m) return;
    const years = axisYears();
    const actual = align(actualSeries('birth'), years);
    const anchorYear = m.baseYear;
    const anchorValue = lastValue(actualSeries('birth'));

    const series = [
      lineSeries('历史（还原值）', actual, COLOR.ink, false, true),
    ];
    ['low', 'base', 'high'].forEach(function (key) {
      const sc = m.scenarios[key];
      if (!sc) return;
      series.push(
        lineSeries(
          sc.label,
          alignFuture(sc.birth, years, anchorYear, anchorValue),
          SCENARIO_COLOR[key] || COLOR.accent,
          true
        )
      );
    });
    series[0].markLine = boundaryMark(m);
    series[0].markArea = futureArea(m);

    const option = baseOption('万人', 1);
    option.yAxis = valueAxis((v) => fmtNum(v, 0));
    option.series = series;
    chart.setOption(option, true);
  }

  /* ---------------- 图：四学段 ---------------- */

  function renderEdu() {
    const chart = chartOf('chart-edu');
    const m = model();
    if (!chart || !m) return;
    const years = axisYears();
    const metric = state.eduMetric;
    const sc = m.scenarios[state.scenario] || m.scenarios.base;

    const series = [];
    const legendData = [];
    const selected = {};

    STAGES.forEach(function (stage) {
      legendData.push(stage.label);
      selected[stage.label] = !state.hidden[stage.key];
      if (state.hidden[stage.key]) return;

      const hist = align(stagePoints('actual', stage.key, metric), years);
      const anchorValue = lastValue(stagePoints('actual', stage.key, metric));
      const fut = sc ? alignFuture(stagePoints(state.scenario, stage.key, metric), years, m.baseYear, anchorValue) : [];

      series.push(lineSeries(stage.label, hist, stage.color, false));
      // 推演段单独一条虚线，名字带「·推演」，工具框里能分清官方与本页推演
      series.push(lineSeries(stage.label + '·推演', fut, stage.color, true));
    });

    if (series.length) {
      series[0].markLine = boundaryMark(m);
      series[0].markArea = futureArea(m);
    }

    const option = baseOption('万人', 1);
    option.legend.data = legendData;
    option.legend.selected = selected;
    option.yAxis = valueAxis((v) => fmtNum(v, 0));
    option.series = series;
    chart.setOption(option, true);

    chart.off('legendselectchanged');
    chart.on('legendselectchanged', function (params) {
      const hit = STAGES.filter((s) => s.label === params.name)[0];
      if (!hit) return;
      // 不能读 params.selected：隐藏后该学段已经没有系列，ECharts 报回来的选中态不可靠，
      // 会变成「点掉之后再也点不回来」。一次点击就是一次翻转，真值只认 state.hidden
      state.hidden[hit.key] = !state.hidden[hit.key];
      renderEdu();
    });
  }

  /* ---------------- 图：购房主力人口 ---------------- */

  function renderBuyer() {
    const chart = chartOf('chart-buyer');
    const m = model();
    if (!chart || !m) return;
    const years = axisYears();
    const actual = align(actualSeries('buyerPop'), years);
    const anchorValue = lastValue(actualSeries('buyerPop'));

    const series = [lineSeries('历史（队列近似）', actual, COLOR.ink, false, true)];
    ['low', 'base', 'high'].forEach(function (key) {
      const sc = m.scenarios[key];
      if (!sc) return;
      series.push(
        lineSeries(sc.label, alignFuture(sc.buyerPop, years, m.baseYear, anchorValue), SCENARIO_COLOR[key], true)
      );
    });
    series[0].markLine = boundaryMark(m);
    series[0].markArea = futureArea(m);

    const option = baseOption('万人', 1);
    option.yAxis = valueAxis((v) => fmtNum(v, 0));
    option.series = series;
    chart.setOption(option, true);
  }

  /* ---------------- 图：销售面积 ---------------- */

  function renderArea() {
    const chart = chartOf('chart-area');
    const m = model();
    if (!chart || !m) return;
    const years = axisYears();
    const actual = align(actualSeries('salesArea'), years);
    const anchorValue = lastValue(actualSeries('salesArea'));

    const series = [lineSeries('官方发布', actual, COLOR.ink, false)];
    ['low', 'base', 'high'].forEach(function (key) {
      const sc = m.scenarios[key];
      if (!sc) return;
      series.push(
        lineSeries(sc.label, alignFuture(sc.salesArea, years, m.baseYear, anchorValue), SCENARIO_COLOR[key], true)
      );
    });
    series[0].markLine = boundaryMark(m);
    series[0].markArea = futureArea(m);

    const option = baseOption('万㎡', 0);
    option.yAxis = valueAxis((v) => fmtNum(v, 0));
    option.series = series;
    chart.setOption(option, true);
  }

  /* ---------------- 图：成交均价 ---------------- */

  function renderPrice() {
    const chart = chartOf('chart-price');
    const m = model();
    if (!chart || !m) return;
    const years = axisYears();
    const actual = align(actualSeries('price'), years);
    const priceYear = lastYear(actualSeries('price'));
    const anchorValue = lastValue(actualSeries('price'));

    const series = [lineSeries('官方发布', actual, COLOR.ink, false)];
    ['low', 'base', 'high'].forEach(function (key) {
      const sc = m.scenarios[key];
      if (!sc) return;
      series.push(
        lineSeries(sc.label, alignFuture(sc.price, years, priceYear, anchorValue), SCENARIO_COLOR[key], true)
      );
    });
    series[0].markLine = {
      silent: true,
      symbol: 'none',
      label: { show: false },
      lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
      data: [{ xAxis: String(m.params.priceYear || priceYear) }],
    };
    series[0].markArea = futureArea(m);

    const option = baseOption('元/㎡', 0);
    option.yAxis = valueAxis((v) => fmtNum(v, 0));
    option.series = series;
    chart.setOption(option, true);
  }

  /* ---------------- KPI ---------------- */

  function renderKpi() {
    const m = model();
    if (!m) return;
    el.kpiRow.replaceChildren();
    (m.kpi || []).forEach(function (k) {
      const card = document.createElement('article');
      card.className = 'kpi';
      const tag = k.id === 'birth' || k.id === 'buyer_2025' ? '<span class="tag warn">计算</span>' : '';
      card.innerHTML =
        '<div class="kpi-label">' + esc(k.label) + tag + '</div>' +
        '<div class="kpi-value">' + fmtNum(k.value, 1) + '<small>' + esc(k.unit || '') + '</small></div>' +
        '<div class="kpi-foot"><span>' + esc(yearCn(k.year)) + '</span>' +
        (k.note ? '<span>' + esc(k.note) + '</span>' : '') +
        '</div>';
      el.kpiRow.appendChild(card);
    });
  }

  /* ---------------- 表：情景对比 ---------------- */

  const SCENARIO_ROWS = [
    { label: '出生人口', unit: '万人', d: 1, get: (sc, y) => pick(sc.birth, y) },
    { label: '小学在校生', unit: '万人', d: 1, get: (sc, y) => pick(sc.stages.primary && sc.stages.primary.enroll, y) },
    { label: '初中在校生', unit: '万人', d: 1, get: (sc, y) => pick(sc.stages.junior && sc.stages.junior.enroll, y) },
    { label: '普高在校生', unit: '万人', d: 1, get: (sc, y) => pick(sc.stages.senior && sc.stages.senior.enroll, y) },
    { label: '本专科在校生', unit: '万人', d: 1, get: (sc, y) => pick(sc.stages.college && sc.stages.college.enroll, y) },
    { label: '购房主力人口', unit: '万人', d: 1, get: (sc, y) => pick(sc.buyerPop, y) },
    { label: '销售面积', unit: '万㎡', d: 0, get: (sc, y) => pick(sc.salesArea, y) },
    { label: '成交均价', unit: '元/㎡', d: 0, get: (sc, y) => pick(sc.price, y) },
  ];

  function pick(points, year) {
    const list = points || [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].year === String(year)) return list[i].value;
    }
    return null;
  }

  function renderScenarioTable() {
    const m = model();
    if (!m) return;
    const nodes = ['2030', '2040', m.horizon];
    el.scenarioTable.replaceChildren();
    ['low', 'base', 'high'].forEach(function (key) {
      const sc = m.scenarios[key];
      if (!sc) return;
      const head = document.createElement('tr');
      head.className = 'group-row';
      head.innerHTML =
        '<td colspan="4">' + esc(sc.label) +
        '　出生年增速 ' + fmtSigned(sc.birthGrowth * 100, 0) + '%' +
        '　购房强度 ' + fmtNum(sc.houseIntensity, 2) +
        '　房价名义增速 ' + fmtSigned(sc.priceGrowth * 100, 0) + '%' +
        '</td>';
      el.scenarioTable.appendChild(head);

      SCENARIO_ROWS.forEach(function (row) {
        const tr = document.createElement('tr');
        const cells = nodes.map(function (y) {
          const v = row.get(sc, y);
          return '<td class="num">' + fmtNum(v, row.d) + '</td>';
        });
        tr.innerHTML = '<td>' + esc(row.label) + ' <small>' + esc(row.unit) + '</small></td>' + cells.join('');
        el.scenarioTable.appendChild(tr);
      });
    });

    // 表头补一列说明：节点年份若与 horizon 重复就只保留一次
    const thead = el.scenarioTable.parentElement.querySelector('thead tr');
    if (thead && thead.children.length === 4) {
      thead.children[3].innerHTML = m.horizon + '<br /><small>推演终点</small>';
    }
  }

  /* ---------------- 表：逐年明细 ---------------- */

  function renderDetailTable() {
    const m = model();
    if (!m) return;
    const metric = state.eduMetric;
    const sc = m.scenarios.base;
    const fromYear = String(Number(m.baseYear) - 9);
    const years = m.years.history
      .filter((y) => y >= fromYear)
      .concat(m.years.future)
      .slice()
      .reverse();

    // 表头随「教育口径」切换：名字写死在这里，不去解析已有 DOM 文本
    const metricCn = metric === 'enroll' ? '在校生' : '招生';
    [
      [el.thEdu, '小学'],
      [el.thJunior, '初中'],
      [el.thSenior, '普高'],
      [el.thCollege, '本专科'],
    ].forEach(function (pair) {
      pair[0].innerHTML = pair[1] + '<br /><small>万人 · ' + metricCn + '</small>';
    });

    el.detailTable.replaceChildren();
    years.forEach(function (y) {
      const isFuture = Number(y) > Number(m.baseYear);
      const tr = document.createElement('tr');
      if (isFuture) tr.className = 'is-future';

      const tag = isFuture ? '<span class="tag warn">推演</span>' : '<span class="tag ok">官方</span>';
      const cells = [
        '<td>' + esc(y) + ' ' + tag + '</td>',
        // 出生人口：历史用官方还原值，未来用基准情景（本表标题已声明「官方值 + 基准情景推演」）
        '<td class="num">' + fmtNum(isFuture ? pick(sc && sc.birth, y) : pick(m.actual.birth, y), 1) + '</td>',
      ];

      STAGES.forEach(function (stage) {
        const src = isFuture ? (sc && sc.stages[stage.key] ? sc.stages[stage.key][metric] : []) : m.actual.stages[stage.key][metric];
        cells.push('<td class="num">' + fmtNum(pick(src, y), 1) + '</td>');
      });

      cells.push('<td class="num">' + fmtNum(isFuture ? pick(sc && sc.buyerPop, y) : pick(m.actual.buyerPop, y), 1) + '</td>');
      cells.push('<td class="num">' + fmtNum(isFuture ? pick(sc && sc.salesArea, y) : pick(m.actual.salesArea, y), 0) + '</td>');
      cells.push('<td class="num">' + fmtNum(isFuture ? pick(sc && sc.price, y) : pick(m.actual.price, y), 0) + '</td>');

      tr.innerHTML = cells.join('');
      el.detailTable.appendChild(tr);
    });
  }

  /* ---------------- 表：回测 ---------------- */

  function renderBacktestTable() {
    const m = model();
    if (!m || !m.backtest) return;
    const bt = m.backtest;
    const nodes = [];
    for (let y = Number(bt.from); y <= Number(bt.to); y += 1) nodes.push(String(y));

    el.backtestTable.replaceChildren();
    Object.keys(bt.stages).forEach(function (key) {
      const st = bt.stages[key];
      const tr = document.createElement('tr');
      const cells = nodes.map(function (y) {
        const pt = (st.points || []).filter((p) => p.year === y)[0];
        if (!pt) return '<td class="num">—</td>';
        const cls = pt.error === null ? 'flat' : signClass(Math.abs(pt.error));
        return (
          '<td class="num">' + fmtNum(pt.actual, 1) +
          '<small class="' + cls + '">' + fmtNum(pt.forecast, 1) +
          (pt.error === null ? '' : '（' + fmtSigned(pt.error * 100, 1) + '%）') +
          '</small></td>'
        );
      });
      tr.innerHTML =
        '<td>' + esc(st.label) + '</td>' +
        '<td class="num">' + fmtNum(st.ratio, 3) + '</td>' +
        '<td class="num">' + (st.mape === null ? '—' : fmtNum(st.mape * 100, 1) + '%') + '</td>' +
        cells.join('');
      el.backtestTable.appendChild(tr);
    });
  }

  /* ---------------- 表：校准系数 ---------------- */

  function renderCalibTable() {
    const m = model();
    if (!m) return;
    el.calibTable.replaceChildren();
    (m.calibration || []).forEach(function (c) {
      const tr = document.createElement('tr');
      const samples = (c.samples || [])
        .map((s) => s.year + '：' + fmtNum(s.ratio, 3))
        .join('　');
      tr.innerHTML =
        '<td>' + esc(c.label) + '</td>' +
        '<td class="num">' + esc(String(c.lag === undefined ? '' : c.lag)) + '</td>' +
        '<td class="num">' + fmtNum(c.ratio, 3) + '</td>' +
        '<td class="num">' + esc(String(c.n)) + '</td>' +
        '<td>' + esc(samples) + '</td>';
      el.calibTable.appendChild(tr);
    });
  }

  /* ---------------- 方法与参数说明 ---------------- */

  function renderNotes() {
    const m = model();
    if (!m) return;
    const notes = (m.params && m.params.notes) || [];
    const bw = m.backtestWindow || {};
    const extra = [
      '回测窗口：' + bw.from + '—' + bw.to + ' 年（系数只用 ' + bw.calibrateFrom + '—' + bw.calibrateTo + ' 年校准，' +
        '上游队列取实际值，所以误差只来自系数漂移）',
      '购房主力：' + m.params.buyerAgeFrom + '—' + m.params.buyerAgeTo + ' 岁，存活率 ' +
        fmtNum(m.params.survival, 2) + '，人均购房强度锚定 ' + yearCn(m.params.anchorYear),
      '均价：以 ' + yearCn(m.params.priceYear) + ' 官方均价 ' +
        fmtNum(pick(m.actual.price, m.params.priceYear), 0) + ' 元/㎡ 为起点做名义外推',
    ];
    el.notes.replaceChildren();
    notes.concat(extra).forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      el.notes.appendChild(li);
    });
  }

  /* ---------------- 状态与页脚 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
  }

  function applyStatus(json) {
    const m = json.model;
    const parts = [];
    parts.push('历史截至 ' + yearCn(m.baseYear) + '（官方）');
    parts.push('推演至 ' + yearCn(json.horizon));
    let kind = '';
    if (json.stale) {
      parts.push('数据可能滞后');
      kind = 'warn';
    }
    if (json.refreshing) parts.push('后台核对中');
    if (json.errors && json.errors.length) {
      parts.push('上游有 ' + json.errors.length + ' 项返回异常，已用缓存');
      kind = 'warn';
    }
    if (json.fetched) parts.push('本次新取 ' + json.fetched + ' 项');
    setStatus(parts.join(' · '), kind);
  }

  function renderMeta() {
    const json = state.data;
    if (!json) return;
    const m = json.model;
    const hist = json.history || {};
    el.rangeHint.textContent =
      '横轴 2000—' + json.horizon + '：实线为官方年度发布值，虚线为本页推演（2026 年起）；' +
      '出生 / 教育 / 房产栏目自 2000 年起有数据，购房队列用的出生序列自 ' + (hist.from || '1978') + ' 年起算';
    el.footMeta.textContent =
      '生成于 ' + (json.generatedAt || '').replace('T', ' ').slice(0, 19) + ' UTC' +
      '　缓存 ' + json.cache.files + ' 个年度文件 / ' + json.cache.indicators + ' 个指标' +
      '　历史 ' + (hist.from || '') + '—' + m.baseYear +
      '　推演 ' + (Number(m.baseYear) + 1) + '—' + json.horizon +
      '　耗时 ' + json.elapsedMs + ' ms';
  }

  /* ---------------- 渲染总入口 ---------------- */

  function renderAll() {
    renderKpi();
    renderBirth();
    renderEdu();
    renderBuyer();
    renderArea();
    renderPrice();
    renderScenarioTable();
    renderDetailTable();
    renderBacktestTable();
    renderCalibTable();
    renderNotes();
    renderMeta();
  }

  /* ---------------- 取数 ---------------- */

  function queryString(force) {
    const q = ['chartFrom=' + state.histFrom];
    if (force) q.push('force=1');
    return q.join('&');
  }

  async function fetchData(force) {
    const res = await fetch(API + '?' + queryString(force), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('接口返回 ' + res.status);
    const json = await res.json();
    if (!json || !json.model) throw new Error('接口数据不完整');
    return json;
  }

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    setStatus(force ? '正在回源核对（首次可能较慢）…' : '正在加载…');
    try {
      const json = await fetchData(force);
      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);
    } catch (e) {
      setStatus('加载失败：' + (e.message || e) + '（确认本地服务已启动，改过后端需重启）', 'error');
      CHART_IDS.forEach(function (id) {
        const chart = chartOf(id);
        if (!chart) return;
        chart.clear();
        chart.setOption({
          title: {
            text: '加载失败',
            left: 'center',
            top: 'middle',
            textStyle: { color: COLOR.muted, fontSize: 13, fontWeight: 400 },
          },
        });
      });
    } finally {
      state.loading = false;
      el.refresh.disabled = false;
    }
  }

  /* ---------------- 后台补齐轮询 ---------------- */

  // 服务端对「有缓存但可能滞后」的栏目不阻塞首屏（先用缓存出图、后台回源），
  // 这里在后台跑完后自己再取一次把新数据换上去；最多补 10 次（约 30 秒），绝不无限轮询。
  let pollTimer = null;
  let pollCount = 0;

  function schedulePoll(json) {
    if (!json || !json.refreshing) {
      pollCount = 0;
      return;
    }
    if (pollCount >= 10) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, 3000);
  }

  async function pollOnce() {
    if (state.loading) return;
    pollCount += 1;
    try {
      const json = await fetchData(false);
      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);
    } catch (e) {
      // 轮询失败不打扰用户，下次操作会重新取数
    }
  }

  /* ---------------- 交互 ---------------- */

  el.eduMetric.value = state.eduMetric;
  el.scenario.value = state.scenario;
  el.histFrom.value = state.histFrom;

  el.eduMetric.addEventListener('change', function () {
    state.eduMetric = el.eduMetric.value;
    state.hidden = {};
    savePref();
    renderEdu();
    renderDetailTable();
  });

  el.scenario.addEventListener('change', function () {
    state.scenario = el.scenario.value;
    state.hidden = {};
    savePref();
    renderEdu();
  });

  el.histFrom.addEventListener('change', function () {
    state.histFrom = el.histFrom.value;
    savePref();
    load(false); // 横轴要重新裁，历史起点不同取的历史长度也不同
  });

  el.refresh.addEventListener('click', function () {
    load(true);
  });

  let resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      Object.keys(state.charts).forEach(function (k) {
        state.charts[k].resize();
      });
    }, 120);
  });

  /* ---------------- 启动 ---------------- */

  (async function boot() {
    loadPref();
    el.eduMetric.value = state.eduMetric;
    el.scenario.value = state.scenario;
    el.histFrom.value = state.histFrom;
    setStatus('正在连接本地服务…（首次打开要拉全历史，约 10 秒）');
    await load(false);
  })();
})();
