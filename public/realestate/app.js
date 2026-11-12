'use strict';

/**
 * 中国房地产开发与销售看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/realestate?range=...
 * 时间范围只作用于月度序列（2000-01 起）；年度序列固定画全历史，不受区间影响。
 *
 * 口径铁律（与页脚一致，改前端别改口径）：
 *   - 房地产所有序列都是「本年累计」，1 月并入 1—2 月发布，一年只有 11 个期别；
 *   - 单月销售面积 / 销售额、成交均价、住宅占比、营业利润率是计算值，图上与表头都标「计算」；
 *   - 累计同比是统计局按可比口径发布的原值，不拿绝对值相除重算；
 *   - 分用途之和不等于总量（还含车位等其他用途），不补差额、不估算；
 *   - 缺失就是缺失，画成空点，不补 0。
 */

(function () {
  // 6 个 KPI：delta 一律取「上年同期 / 上一年」的点现算差值，不读上游同比
  const KPI_LIST = [
    { id: 'sales_area', prevLabel: '较上年同期', deltaUnit: '万㎡' },
    { id: 'sales_amount', prevLabel: '较上年同期', deltaUnit: '亿元' },
    { id: 'sales_area_month', prevLabel: '较上年同月', deltaUnit: '万㎡' },
    { id: 'avg_price', prevLabel: '较上年同期', deltaUnit: '元/㎡' },
    { id: 'inv_total', prevLabel: '较上年同期', deltaUnit: '亿元' },
    { id: 'ann_sales_amount', prevLabel: '较上年', deltaUnit: '亿元' },
  ];

  // 月度明细表列（顺序必须与 index.html 的 thead 一致）
  const COLS_MONTH = [
    { id: 'sales_area', d: 0 },
    { id: 'sales_area_month', d: 0 },
    { id: 'sales_area_yoy', d: 1, signed: true },
    { id: 'sales_amount', d: 0 },
    { id: 'sales_amount_month', d: 0 },
    { id: 'sales_amount_yoy', d: 1, signed: true },
    { id: 'sales_area_res', d: 0 },
    { id: 'sales_amount_res', d: 0 },
    { id: 'avg_price_res', d: 0 },
    { id: 'inv_total', d: 0 },
    { id: 'inv_total_yoy', d: 1, signed: true },
    { id: 'area_build', d: 0 },
    { id: 'area_start', d: 0 },
    { id: 'area_done', d: 0 },
    { id: 'fund_total', d: 0 },
  ];

  // 年度明细表列（顺序必须与 index.html 的 thead 一致）
  const COLS_YEAR = [
    { id: 'ann_sales_area', d: 0 },
    { id: 'ann_sales_amount', d: 0 },
    { id: 'ann_price', d: 0 },
    { id: 'ann_sales_area_res', d: 0 },
    { id: 'ann_sales_amount_res', d: 0 },
    { id: 'ann_inv', d: 0 },
    { id: 'ann_start', d: 0 },
    { id: 'ann_done', d: 0 },
    { id: 'ann_build', d: 0 },
    { id: 'ann_fund', d: 0 },
    { id: 'ann_fund_deposit', d: 0 },
    { id: 'ann_fund_mortgage', d: 0 },
    { id: 'ann_profit', d: 0 },
    { id: 'ann_margin', d: 1 },
  ];

  const COLOR = {
    ink: '#16181d',
    muted: '#7b8391',
    line: '#e8eaee',
    lineStrong: '#d9dce2',
    accent: '#175cd3',
    accentLight: '#5b8def',
    teal: '#0e7490',
    tealLight: '#0891b2',
    amber: '#b45309',
    amberLight: '#d97706',
    violet: '#7c3aed',
    up: '#d14343',
    down: '#1f9254',
    flat: '#98a1ae',
  };

  // 用户可选的时间范围存本地：改默认值时必须同时升级这个键名（v1 -> v2）
  const RANGE_KEY = 'realestate.range.v1';
  const DEFAULT_RANGE = '5';
  const API = '/api/realestate';

  const CHART_IDS = [
    'chart-sales',
    'chart-month',
    'chart-mix',
    'chart-invest',
    'chart-build',
    'chart-fund',
    'chart-price',
    'chart-annual-sales',
    'chart-annual-build',
    'chart-annual-fund',
    'chart-annual-ops',
  ];

  const state = {
    range: DEFAULT_RANGE,
    from: '',
    to: '',
    data: null,
    loading: false,
    charts: {},
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    range: $('range'),
    from: $('from'),
    to: $('to'),
    customBox: $('custom-box'),
    exportBtn: $('export-csv'),
    refresh: $('refresh'),
    status: $('status'),
    rangeHint: $('range-hint'),
    kpiRow: $('kpi-row'),
    monthTable: $('detail-month').querySelector('tbody'),
    yearTable: $('detail-year').querySelector('tbody'),
    footMeta: $('foot-meta'),
  };

  /* ---------------- 本地偏好 ---------------- */

  function isMonth(v) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(v || '');
  }

  function loadPref() {
    // 地址栏优先：别人发来的链接要打开成他看到的那一屏
    const qsFrom = Board.qs('from');
    const qsTo = Board.qs('to');
    if (isMonth(qsFrom) && isMonth(qsTo)) {
      state.range = 'custom';
      state.from = qsFrom;
      state.to = qsTo;
      return;
    }
    const qsRange = Board.qs('range');
    if (qsRange === 'all' || /^\d+$/.test(qsRange || '')) {
      state.range = qsRange;
      return;
    }

    try {
      const raw = localStorage.getItem(RANGE_KEY);
      if (!raw) return;
      const pref = JSON.parse(raw);
      if (!pref) return;
      if (pref.range === 'custom') {
        if (isMonth(pref.from) && isMonth(pref.to)) {
          state.range = 'custom';
          state.from = pref.from;
          state.to = pref.to;
        }
        return;
      }
      if (/^\d+$/.test(pref.range || '') || pref.range === 'all') state.range = pref.range;
    } catch (e) {
      // 本地存的东西坏了就当没有
    }
  }

  function savePref() {
    try {
      localStorage.setItem(RANGE_KEY, JSON.stringify({ range: state.range, from: state.from, to: state.to }));
    } catch (e) {
      // 隐私模式下写不了，不影响使用
    }
  }

  /** 视图写回地址栏（不刷新、不新增历史）；自定义区间才会带 from/to */
  function syncQuery() {
    const custom = state.range === 'custom';
    Board.setQs({
      range: custom ? null : state.range,
      from: custom ? state.from : null,
      to: custom ? state.to : null,
    });
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

  /** '2026-09' → '2026 年 9 月'；'2026-02' → '2026 年 1—2 月'（合并发布） */
  function monthCn(key) {
    if (!key) return '—';
    const mo = Number(key.slice(5, 7));
    if (mo === 2) return key.slice(0, 4) + ' 年 1—2 月';
    return key.slice(0, 4) + ' 年 ' + mo + ' 月';
  }

  /** '2025' → '2025 年' */
  function yearCn(key) {
    return key ? key + ' 年' : '—';
  }

  function periodCn(key, freq) {
    return freq === 'year' ? yearCn(key) : monthCn(key);
  }

  /** 上年同月 / 上一年 */
  function prevPeriod(key, freq) {
    if (!key) return '';
    if (freq === 'year') return String(Number(key) - 1);
    return Number(key.slice(0, 4)) - 1 + key.slice(4);
  }

  /* ---------------- 数据访问 ---------------- */

  function byId(id) {
    if (!state.data) return null;
    return state.data.indicators.filter((x) => x.id === id)[0] || null;
  }

  /** 月度横轴：取总销售面积的期别（所有月度序列共用同一区间） */
  function monthsOf() {
    const ind = byId('sales_area') || (state.data && state.data.indicators[0]);
    return ind ? ind.points.map((p) => p.period) : [];
  }

  /** 年度横轴：给定指标各自期别的并集，升序 */
  function yearsOf(ids) {
    const set = new Set();
    ids.forEach((id) => {
      const ind = byId(id);
      if (!ind) return;
      ind.points.forEach((p) => {
        if (p.value !== null) set.add(p.period);
      });
    });
    return Array.from(set).sort();
  }

  function pointsOf(id) {
    const ind = byId(id);
    return ind ? ind.points : [];
  }

  /** 与 periods 对齐的一维数组 */
  function seriesAt(periods, id) {
    const map = new Map(pointsOf(id).map((p) => [p.period, p.value]));
    return periods.map((key) => (map.has(key) ? map.get(key) : null));
  }

  function pointAt(id, period) {
    const hit = pointsOf(id).filter((p) => p.period === period)[0];
    return hit && hit.value !== null ? hit.value : null;
  }

  /** 该指标在所选区间内最后一个有数据的点 */
  function lastPoint(ind) {
    if (!ind) return null;
    const hit = ind.points.filter((p) => p.value !== null);
    return hit.length ? hit[hit.length - 1] : null;
  }

  /** 两个序列逐期相除（占比，%），任一侧缺失就是 null */
  function shareOf(periods, numId, denId) {
    return periods.map((p) => {
      const a = pointAt(numId, p);
      const b = pointAt(denId, p);
      if (a === null || b === null || b === 0) return null;
      return Number(((a / b) * 100).toFixed(1));
    });
  }

  /* ---------------- 图表基座 ---------------- */

  function chartOf(id) {
    const dom = document.getElementById(id);
    if (!dom) return null;
    if (!state.charts[id]) state.charts[id] = echarts.init(dom, null, { renderer: 'canvas' });
    return state.charts[id];
  }

  function leftAxis(formatter, scale) {
    return {
      type: 'value',
      position: 'left',
      scale: !!scale,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: formatter || ((v) => fmtNum(v, 1)) },
      splitLine: { lineStyle: { color: COLOR.line } },
    };
  }

  function rightAxis(formatter) {
    return {
      type: 'value',
      position: 'right',
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: formatter || ((v) => fmtNum(v, 1) + '%') },
      splitLine: { show: false },
    };
  }

  function base(freq, dual) {
    const option = {
      animationDuration: 420,
      grid: { left: 8, right: 8, top: 44, bottom: 26, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: COLOR.lineStrong } },
        backgroundColor: 'rgba(22,24,29,0.92)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        padding: [8, 10],
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
        boundaryGap: freq === 'year',
        axisLine: { lineStyle: { color: COLOR.lineStrong } },
        axisTick: { show: false },
        axisLabel:
          freq === 'year'
            ? { color: COLOR.muted, fontSize: 11, hideOverlap: true }
            : {
                color: COLOR.muted,
                fontSize: 11,
                hideOverlap: true,
                // 月度标签太长会把轴挤满：只留「年-月」的后 5 位
                formatter: (v) => String(v).slice(2),
              },
      },
      yAxis: [leftAxis()],
    };
    if (dual) option.yAxis.push(rightAxis());
    return option;
  }

  /** tooltip：按 seriesIndex 取单位与小数位 */
  function makeTooltip(periods, specs, freq) {
    return (params) => {
      if (!params || !params.length) return '';
      const head = periodCn(periods[params[0].dataIndex], freq);
      const rows = params.map((p) => {
        const spec = specs[p.seriesIndex] || {};
        const d = typeof spec.decimals === 'number' ? spec.decimals : 1;
        const v = p.value === null || p.value === undefined ? '—' : fmtNum(p.value, d) + (spec.suffix || '');
        // 系列名来自本文件常量，仍统一转义，避免以后有人把上游字段塞进来
        return p.marker + ' ' + esc(p.seriesName) + '　' + v;
      });
      return esc(head) + '<br/>' + rows.join('<br/>');
    };
  }

  function line(name, values, color, extra) {
    return Object.assign(
      {
        name: name,
        type: 'line',
        data: values,
        smooth: 0.2,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 6,
        connectNulls: false,
        lineStyle: { width: 2, color: color },
        itemStyle: { color: color },
        emphasis: { focus: 'series' },
      },
      extra || {}
    );
  }

  function bar(name, values, color, extra) {
    return Object.assign(
      {
        name: name,
        type: 'bar',
        data: values,
        barMaxWidth: 22,
        itemStyle: { color: color, borderRadius: [2, 2, 0, 0] },
        emphasis: { focus: 'series' },
      },
      extra || {}
    );
  }

  function dashed(name, values, color, extra) {
    return line(
      name,
      values,
      color,
      Object.assign({ yAxisIndex: 1, lineStyle: { width: 1.6, color: color, type: 'dashed' } }, extra || {})
    );
  }

  /** 右轴 0 参考线（同比 / 利润率看正负） */
  function zeroLine(label) {
    return {
      silent: true,
      symbol: 'none',
      label: { formatter: label, color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
      lineStyle: { color: COLOR.flat, type: 'dashed', width: 1 },
      data: [{ yAxis: 0 }],
    };
  }

  function emptyChart(id, text) {
    const chart = chartOf(id);
    if (!chart) return;
    chart.clear();
    chart.setOption({
      graphic: [
        { type: 'text', left: 'center', top: 'middle', style: { text: text, fill: COLOR.muted, fontSize: 13 } },
      ],
    });
  }

  function apply(id, option) {
    const chart = chartOf(id);
    if (!chart) return;
    chart.setOption(option, true);
  }

  /* ---------------- 各图（月度） ---------------- */

  function renderSales() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-sales', '暂无数据');
    const option = base('month', true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    option.tooltip.formatter = makeTooltip(
      months,
      [{ suffix: ' 万㎡', decimals: 0 }, { suffix: ' 亿元', decimals: 0 }],
      'month'
    );
    option.series = [
      bar('销售面积（累计 · 万㎡）', seriesAt(months, 'sales_area'), COLOR.accentLight, { barMaxWidth: 12 }),
      line('销售额（累计 · 亿元）', seriesAt(months, 'sales_amount'), COLOR.amber, { yAxisIndex: 1 }),
    ];
    apply('chart-sales', option);
  }

  function renderMonth() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-month', '暂无数据');
    const option = base('month', true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 1) + '%');
    option.tooltip.formatter = makeTooltip(
      months,
      [{ suffix: ' 万㎡', decimals: 0 }, { suffix: '%' }],
      'month'
    );
    option.series = [
      bar('单月销售面积（计算 · 万㎡）', seriesAt(months, 'sales_area_month'), COLOR.accent, { barMaxWidth: 14 }),
      dashed('累计同比（% · 官方）', seriesAt(months, 'sales_area_yoy'), COLOR.amber, {
        markLine: zeroLine('0 = 持平'),
      }),
    ];
    apply('chart-month', option);
  }

  function renderMix() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-mix', '暂无数据');
    const option = base('month', true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    // 右轴单独给办公楼 / 商业：它们比住宅小一个数量级，与住宅共用一根轴会被压成一条贴底直线
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    const baseTip = makeTooltip(
      months,
      [{ suffix: ' 万㎡', decimals: 0 }, { suffix: ' 万㎡', decimals: 0 }, { suffix: ' 万㎡', decimals: 0 }],
      'month'
    );
    const share = shareOf(months, 'sales_area_res', 'sales_area');
    option.tooltip.formatter = (params) => {
      const pct = share[params[0].dataIndex];
      return baseTip(params) + '<br/>住宅占商品房销售面积：' + (pct === null ? '—' : fmtNum(pct, 1) + '%');
    };
    option.series = [
      line('住宅（左轴）', seriesAt(months, 'sales_area_res'), COLOR.accent),
      line('办公楼（右轴）', seriesAt(months, 'sales_area_office'), COLOR.teal, { yAxisIndex: 1 }),
      line('商业营业用房（右轴）', seriesAt(months, 'sales_area_comm'), COLOR.violet, { yAxisIndex: 1 }),
    ];
    apply('chart-mix', option);
  }

  function renderInvest() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-invest', '暂无数据');
    const option = base('month', true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 1) + '%');
    option.tooltip.formatter = makeTooltip(
      months,
      [{ suffix: ' 亿元', decimals: 0 }, { suffix: ' 亿元', decimals: 0 }, { suffix: '%' }],
      'month'
    );
    option.series = [
      bar('开发投资总额（累计 · 亿元）', seriesAt(months, 'inv_total'), COLOR.accentLight, { barMaxWidth: 14 }),
      line('其中住宅投资（亿元）', seriesAt(months, 'inv_res'), COLOR.teal),
      dashed('投资累计同比（% · 官方）', seriesAt(months, 'inv_total_yoy'), COLOR.amber, {
        markLine: zeroLine('0 = 持平'),
      }),
    ];
    apply('chart-invest', option);
  }

  function renderBuild() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-build', '暂无数据');
    const option = base('month', true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    // 施工面积是含上年结转的存量，比新开工 / 竣工大一个数量级：单独给左轴，另两项走右轴
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    option.tooltip.formatter = makeTooltip(
      months,
      [{ suffix: ' 万㎡', decimals: 0 }, { suffix: ' 万㎡', decimals: 0 }, { suffix: ' 万㎡', decimals: 0 }],
      'month'
    );
    option.series = [
      line('施工面积（左轴 · 含上年结转）', seriesAt(months, 'area_build'), COLOR.accent),
      line('新开工面积（右轴）', seriesAt(months, 'area_start'), COLOR.amber, { yAxisIndex: 1 }),
      line('竣工面积（右轴）', seriesAt(months, 'area_done'), COLOR.teal, { yAxisIndex: 1 }),
    ];
    apply('chart-build', option);
  }

  function renderFund() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-fund', '暂无数据');
    const option = base('month', false);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.tooltip.formatter = makeTooltip(
      months,
      [
        { suffix: ' 亿元', decimals: 0 },
        { suffix: ' 亿元', decimals: 0 },
        { suffix: ' 亿元', decimals: 0 },
        { suffix: ' 亿元', decimals: 0 },
      ],
      'month'
    );
    option.series = [
      bar('到位资金小计（累计 · 亿元）', seriesAt(months, 'fund_total'), COLOR.accentLight, { barMaxWidth: 14 }),
      line('国内贷款', seriesAt(months, 'fund_loan'), COLOR.accent),
      line('自筹资金', seriesAt(months, 'fund_self'), COLOR.teal),
      line('利用外资', seriesAt(months, 'fund_foreign'), COLOR.flat),
    ];
    apply('chart-fund', option);
  }

  function renderPrice() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-price', '暂无数据');
    const option = base('month', false);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), true);
    option.tooltip.formatter = makeTooltip(
      months,
      [{ suffix: ' 元/㎡', decimals: 0 }, { suffix: ' 元/㎡', decimals: 0 }],
      'month'
    );
    option.series = [
      line('全部用途均价（计算）', seriesAt(months, 'avg_price'), COLOR.accent),
      line('住宅均价（计算）', seriesAt(months, 'avg_price_res'), COLOR.teal),
    ];
    apply('chart-price', option);
  }

  /* ---------------- 各图（年度） ---------------- */

  function renderAnnualSales() {
    const years = yearsOf(['ann_sales_area', 'ann_sales_amount']);
    if (!years.length) return emptyChart('chart-annual-sales', '暂无数据');
    const option = base('year', true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    option.tooltip.formatter = makeTooltip(
      years,
      [{ suffix: ' 万㎡', decimals: 0 }, { suffix: ' 亿元', decimals: 0 }],
      'year'
    );
    option.series = [
      bar('全年销售面积（万㎡）', seriesAt(years, 'ann_sales_area'), COLOR.accentLight, { barMaxWidth: 16 }),
      line('全年销售额（亿元）', seriesAt(years, 'ann_sales_amount'), COLOR.amber, { yAxisIndex: 1 }),
    ];
    apply('chart-annual-sales', option);
  }

  function renderAnnualBuild() {
    const years = yearsOf(['ann_inv', 'ann_start', 'ann_done']);
    if (!years.length) return emptyChart('chart-annual-build', '暂无数据');
    const option = base('year', true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    option.tooltip.formatter = makeTooltip(
      years,
      [{ suffix: ' 万㎡', decimals: 0 }, { suffix: ' 万㎡', decimals: 0 }, { suffix: ' 亿元', decimals: 0 }],
      'year'
    );
    option.series = [
      line('新开工面积（万㎡）', seriesAt(years, 'ann_start'), COLOR.amber),
      line('竣工面积（万㎡）', seriesAt(years, 'ann_done'), COLOR.teal),
      bar('开发投资（亿元）', seriesAt(years, 'ann_inv'), COLOR.accentLight, { yAxisIndex: 1, barMaxWidth: 16 }),
    ];
    apply('chart-annual-build', option);
  }

  function renderAnnualFund() {
    const ids = [
      'ann_fund_loan',
      'ann_fund_foreign',
      'ann_fund_self',
      'ann_fund_deposit',
      'ann_fund_mortgage',
      'ann_fund_other',
    ];
    const years = yearsOf(ids.concat('ann_fund'));
    if (!years.length) return emptyChart('chart-annual-fund', '暂无数据');
    const option = base('year', false);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.tooltip.formatter = makeTooltip(
      years,
      ids.map(() => ({ suffix: ' 亿元', decimals: 0 })).concat({ suffix: ' 亿元', decimals: 0 }),
      'year'
    );
    const parts = [
      ['国内贷款', 'ann_fund_loan', COLOR.accent],
      ['利用外资', 'ann_fund_foreign', COLOR.flat],
      ['自筹资金', 'ann_fund_self', COLOR.teal],
      ['定金及预收款', 'ann_fund_deposit', COLOR.amber],
      ['个人按揭贷款', 'ann_fund_mortgage', COLOR.violet],
      ['其他资金', 'ann_fund_other', COLOR.accentLight],
    ];
    option.series = parts
      .map((p) => bar(p[0], seriesAt(years, p[1]), p[2], { stack: 'fund', barMaxWidth: 26 }))
      .concat(line('到位资金小计', seriesAt(years, 'ann_fund'), COLOR.ink, { lineStyle: { width: 1.6, type: 'dashed' } }));
    apply('chart-annual-fund', option);
  }

  function renderAnnualOps() {
    const years = yearsOf(['ann_rev', 'ann_profit', 'ann_margin', 'ann_debt_ratio']);
    if (!years.length) return emptyChart('chart-annual-ops', '暂无数据');
    const option = base('year', true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 1) + '%');
    option.tooltip.formatter = makeTooltip(
      years,
      [
        { suffix: ' 亿元', decimals: 0 },
        { suffix: ' 亿元', decimals: 0 },
        { suffix: '%' },
        { suffix: '%' },
      ],
      'year'
    );
    option.series = [
      bar('主营业务收入（亿元）', seriesAt(years, 'ann_rev'), COLOR.accentLight, { barMaxWidth: 16 }),
      line('营业利润（亿元）', seriesAt(years, 'ann_profit'), COLOR.teal),
      dashed('营业利润率（计算 · %）', seriesAt(years, 'ann_margin'), COLOR.violet),
      dashed('资产负债率（% · 官方）', seriesAt(years, 'ann_debt_ratio'), COLOR.amber),
    ];
    apply('chart-annual-ops', option);
  }

  /* ---------------- KPI ---------------- */

  /** 小工具：建节点 + 文本（一律走 textContent，不拼 HTML 字符串） */
  function node(tag, className, text) {
    const dom = document.createElement(tag);
    if (className) dom.className = className;
    if (text !== undefined) dom.textContent = text;
    return dom;
  }

  function renderKpi() {
    el.kpiRow.replaceChildren();
    KPI_LIST.forEach((cfg) => {
      const card = node('div', 'kpi');
      const label = node('div', 'kpi-label');
      const ind = byId(cfg.id);
      const latest = lastPoint(ind);

      if (!ind || !latest) {
        label.textContent = ind ? ind.shortLabel || ind.label : cfg.id;
        card.appendChild(label);
        card.appendChild(node('div', 'kpi-value', '—'));
        el.kpiRow.appendChild(card);
        return;
      }

      label.appendChild(document.createTextNode(ind.shortLabel || ind.label));
      if (ind.freq === 'year') label.appendChild(node('span', 'tag', '年度'));
      if (ind.computed) label.appendChild(node('span', 'tag', '计算值'));
      if (ind.stale) label.appendChild(node('span', 'tag warn', '待更新'));
      card.appendChild(label);

      const value = node('div', 'kpi-value');
      value.appendChild(document.createTextNode(fmtNum(latest.value, ind.decimals)));
      value.appendChild(node('small', '', ind.unit));
      card.appendChild(value);

      const foot = node('div', 'kpi-foot');
      foot.appendChild(node('span', '', periodCn(latest.period, ind.freq)));

      const prev = pointAt(cfg.id, prevPeriod(latest.period, ind.freq));
      if (prev === null) {
        foot.appendChild(node('span', 'kpi-delta flat', cfg.prevLabel + ' —'));
      } else {
        const delta = Number((latest.value - prev).toFixed(Math.max(ind.decimals || 1, 1)));
        foot.appendChild(
          node(
            'span',
            'kpi-delta ' + signClass(delta),
            cfg.prevLabel + ' ' + fmtSigned(delta, ind.decimals || 1) + ' ' + cfg.deltaUnit
          )
        );
      }
      card.appendChild(foot);

      el.kpiRow.appendChild(card);
    });
  }

  /* ---------------- 明细表 ---------------- */

  function cell(text, cls) {
    return node('td', cls, text);
  }

  /** 按年分组、年份倒序、同一年内月份升序 */
  function groupedMonths() {
    const map = new Map();
    monthsOf().forEach((m) => {
      const y = m.slice(0, 4);
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(m);
    });
    return Array.from(map.keys())
      .sort()
      .reverse()
      .map((y) => ({ year: y, months: map.get(y) }));
  }

  function renderMonthTable() {
    if (!state.data) return;
    el.monthTable.replaceChildren();
    const cols = COLS_MONTH.length + 1;

    groupedMonths().forEach((group) => {
      const head = document.createElement('tr');
      head.className = 'group-row';
      const headCell = cell(group.year + ' 年　·　' + group.months.length + ' 个期别（1 月并入 1—2 月）');
      headCell.colSpan = cols;
      head.appendChild(headCell);
      el.monthTable.appendChild(head);

      group.months.forEach((month) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(monthCn(month)));
        COLS_MONTH.forEach((c) => {
          const v = pointAt(c.id, month);
          const text = c.signed && v !== null ? fmtSigned(v, c.d) : fmtNum(v, c.d);
          tr.appendChild(cell(text, 'num' + (c.signed && v !== null ? ' ' + signClass(v) : '')));
        });
        el.monthTable.appendChild(tr);
      });
    });

    if (!el.monthTable.children.length) {
      const tr = document.createElement('tr');
      const td = cell('暂无数据');
      td.colSpan = cols;
      tr.appendChild(td);
      el.monthTable.appendChild(tr);
    }
  }

  function renderYearTable() {
    if (!state.data) return;
    el.yearTable.replaceChildren();
    const years = yearsOf(COLS_YEAR.map((c) => c.id))
      .slice()
      .reverse();

    years.forEach((year) => {
      const tr = document.createElement('tr');
      tr.appendChild(cell(yearCn(year)));
      COLS_YEAR.forEach((c) => tr.appendChild(cell(fmtNum(pointAt(c.id, year), c.d), 'num')));
      el.yearTable.appendChild(tr);
    });

    if (!el.yearTable.children.length) {
      const tr = document.createElement('tr');
      const td = cell('暂无数据');
      td.colSpan = COLS_YEAR.length + 1;
      tr.appendChild(td);
      el.yearTable.appendChild(tr);
    }
  }

  /* ---------------- CSV 导出 ---------------- */

  // 这三列虽然缺 derive 标记，但确实是本页计算值，导出时必须标出来
  const CALC_MONTH = ['sales_area_month', 'sales_amount_month', 'avg_price_res'];

  function indOf(id) {
    return byId(id) || {};
  }

  function colOf(id, extra) {
    const ind = indOf(id);
    return {
      key: id,
      label: ind.shortLabel || ind.label || id,
      unit: ind.unit || '',
      calc: !!extra,
    };
  }

  /** 导出当前视图：月度明细按所选区间，年度明细与页面一致固定全历史 */
  function buildCsv() {
    if (!state.data) {
      window.alert('数据还没加载完成，稍后再导出。');
      return;
    }
    const months = monthsOf();
    if (!months.length) {
      window.alert('当前区间还没有数据可导出。');
      return;
    }

    const monthCols = [{ key: 'month', label: '月份' }].concat(
      COLS_MONTH.map((c) => colOf(c.id, CALC_MONTH.indexOf(c.id) >= 0))
    );
    const monthRows = months.map((m) => {
      const row = { month: m };
      COLS_MONTH.forEach((c) => {
        const v = pointAt(c.id, m);
        row[c.id] = v === null ? '' : v;
      });
      return row;
    });

    const yearCols = [{ key: 'year', label: '年份' }].concat(
      COLS_YEAR.map((c) => colOf(c.id, c.id === 'ann_margin'))
    );
    const years = yearsOf(COLS_YEAR.map((c) => c.id));
    const yearRows = years.map((y) => {
      const row = { year: y };
      COLS_YEAR.forEach((c) => {
        const v = pointAt(c.id, y);
        row[c.id] = v === null ? '' : v;
      });
      return row;
    });

    Board.csv(
      {
        file: 'realestate',
        fileSuffix: months[0] + '_' + months[months.length - 1],
        module: '中国房地产开发与销售看板',
        source: '国家统计局 · 国家数据（月度库 · 房地产；年度库 · 固定资产投资和房地产）',
        interface: '/api/realestate',
        range:
          '月度 ' +
          months[0] +
          ' ~ ' +
          months[months.length - 1] +
          '（' +
          months.length +
          ' 个期别）；年度 ' +
          (years.length ? years[0] + ' ~ ' + years[years.length - 1] : '无'),
        note: [
          '所有数值都是「本年 1 月至本期」累计口径，不是当月值；1 月并入 1—2 月发布，一年只有 11 个期别',
          '单月销售面积 / 单月销售额 = 本月累计 − 上月累计；1—2 月没有上月可比，直接取累计值，属本页计算值',
          '成交均价 = 销售额 ÷ 销售面积 × 10000，是成交结构均价，与 70 城房价指数口径不同，不能互相替代',
          '年度块固定导出全部年份，不受上方时间范围影响；营业利润率 = 营业利润 ÷ 营业收入 × 100，为本页计算值',
          '空单元格表示官方未发布或该期无值，不插值、不补 0；三类用途之和不等于商品房总量属正常口径，不补差额',
        ],
      },
      [
        { title: '月度明细', columns: monthCols, rows: monthRows },
        { title: '年度明细', columns: yearCols, rows: yearRows },
      ]
    );
  }

  Board.onExport(el.exportBtn, buildCsv);

  /* ---------------- 状态栏 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.title = text;
  }

  // 首次运行要拉 22 个栏目：超过 3 秒还没回来就换一句提示，避免用户以为卡住
  let slowHintTimer = null;

  function hintSlow() {
    clearTimeout(slowHintTimer);
    if (state.data) return;
    slowHintTimer = setTimeout(function () {
      setStatus('首次运行或缓存落后，正在向统计局补齐数据，约需半分钟…');
    }, 3000);
  }

  function clearHint() {
    clearTimeout(slowHintTimer);
  }

  /** 状态栏只看服务端给的 stale / errors / expectedMonth，不自己猜月份 */
  function applyStatus(json) {
    const staleList = json.indicators.filter((x) => x.stale);
    const busy = json.refreshing ? '（后台补齐中…）' : '';

    if (json.errors && json.errors.length) {
      setStatus(
        '上游异常，' + staleList.length + ' 个指标已回退缓存（最新月度 ' + (json.latestMonth || '—') + '）' + busy,
        'warn'
      );
      el.status.title = json.errors.join('\n');
      return;
    }
    if (!staleList.length) {
      const first = json.firstRun ? '　首次运行已把全部历史写入缓存' : '';
      setStatus(
        '数据完整　最新月度 ' +
          (json.latestMonth || '—') +
          '（应发布 ' +
          (json.expectedMonth || '—') +
          '）· 年度 ' +
          (json.latestYear || '—') +
          (json.fetched ? '　本次回源 ' + json.fetched + ' 个栏目' : '　全部命中本地缓存') +
          busy +
          first,
        'ok'
      );
      return;
    }
    const names = staleList.map((x) => x.shortLabel || x.label).join('、');
    setStatus(
      '数据可能滞后：' +
        names +
        '（最新月度 ' +
        (json.latestMonth || '—') +
        '，应发布 ' +
        (json.expectedMonth || '—') +
        '）' +
        busy,
      'warn'
    );
  }

  function renderMeta() {
    const d = state.data;
    if (!d) return;
    const count = monthsOf().length;
    el.rangeHint.textContent =
      '当前区间：' +
      monthCn(d.range.from) +
      ' ~ ' +
      monthCn(d.range.to) +
      '　' +
      d.range.label +
      '　月度共 ' +
      count +
      ' 个期别（每年 11 期，1 月并入 1—2 月）；最新月度 ' +
      (d.latestMonth || '—') +
      '，应发布到 ' +
      (d.expectedMonth || '—') +
      '（统计局每月 15 日左右发布上月累计数）；年度最新 ' +
      (d.latestYear || '—') +
      ' 年（时间范围只作用于月度序列，年度固定画全历史）';

    el.footMeta.textContent =
      '生成时间 ' +
      new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false }) +
      '　耗时 ' +
      d.elapsedMs +
      ' ms　本次回源 ' +
      d.fetched +
      ' 个栏目　缓存目录 ' +
      d.cache.dir +
      '（' +
      d.cache.catalogs +
      ' 个栏目 / ' +
      d.cache.series +
      ' 条序列 / ' +
      d.cache.points +
      ' 个数据点，月度 ' +
      d.cache.months +
      ' 期、年度 ' +
      d.cache.years +
      ' 年，最新 ' +
      (d.cache.latestMonth || '—') +
      ' / ' +
      (d.cache.latestYear || '—') +
      '）';
  }

  /* ---------------- 数据加载 ---------------- */

  function queryString(force) {
    const q = [];
    if (state.range === 'custom') {
      if (state.from) q.push('from=' + state.from);
      if (state.to) q.push('to=' + state.to);
    } else {
      q.push('range=' + encodeURIComponent(state.range));
    }
    if (force) q.push('force=1');
    return q.join('&');
  }

  async function fetchData(force) {
    const res = await fetch(API + '?' + queryString(force), { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);
    return json;
  }

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    clearTimeout(pollTimer);
    pollCount = 0;
    setStatus(force ? '正在重新向统计局请求…' : '正在读取数据…');
    hintSlow();

    try {
      const json = await fetchData(force);
      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);
      syncInputs(json);
    } catch (e) {
      setStatus('加载失败：' + (e.message || e), 'error');
      if (!state.data) CHART_IDS.forEach((id) => emptyChart(id, '加载失败'));
    } finally {
      clearHint();
      state.loading = false;
      el.refresh.disabled = false;
    }
  }

  function renderAll() {
    renderKpi();
    renderSales();
    renderMonth();
    renderMix();
    renderInvest();
    renderBuild();
    renderFund();
    renderPrice();
    renderAnnualSales();
    renderAnnualBuild();
    renderAnnualFund();
    renderAnnualOps();
    renderMonthTable();
    renderYearTable();
    renderMeta();
  }

  /* ---------------- 交互 ---------------- */

  function syncInputs(json) {
    if (!json || !json.history) return;
    el.from.min = json.history.month;
    el.to.max = json.expectedMonth;
    if (!el.from.value) el.from.value = json.range.from;
    if (!el.to.value) el.to.value = json.range.to;
  }

  function buildRangeSelect(presets) {
    if (!presets || !presets.length) return; // 接口异常时保留 HTML 里的静态选项
    el.range.replaceChildren();
    const keys = presets.map((p) => p.key);
    presets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label;
      el.range.appendChild(opt);
    });
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = '自定义月份';
    el.range.appendChild(custom);

    const valid = state.range === 'custom' || keys.indexOf(state.range) >= 0;
    state.range = valid ? state.range : DEFAULT_RANGE;
    el.range.value = state.range;
    el.customBox.hidden = state.range !== 'custom';
  }

  el.range.addEventListener('change', () => {
    state.range = el.range.value;
    const custom = state.range === 'custom';
    el.customBox.hidden = !custom;
    if (custom) {
      if (!el.from.value && state.data) el.from.value = state.data.range.from;
      if (!el.to.value && state.data) el.to.value = state.data.range.to;
      state.from = el.from.value;
      state.to = el.to.value;
      savePref();
      syncQuery();
      if (isMonth(state.from) && isMonth(state.to)) load(false);
      return;
    }
    state.from = '';
    state.to = '';
    savePref();
    syncQuery();
    load(false);
  });

  el.from.addEventListener('change', () => {
    state.from = el.from.value;
    savePref();
    syncQuery();
    if (state.range === 'custom' && isMonth(state.from) && isMonth(state.to)) load(false);
  });

  el.to.addEventListener('change', () => {
    state.to = el.to.value;
    savePref();
    syncQuery();
    if (state.range === 'custom' && isMonth(state.from) && isMonth(state.to)) load(false);
  });

  el.refresh.addEventListener('click', () => load(true));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      Object.keys(state.charts).forEach((k) => state.charts[k].resize());
    }, 120);
  });

  /* ---------------- 后台补齐轮询 ---------------- */

  // 服务端对「有缓存但可能滞后」的栏目不阻塞首屏（先用缓存出图、后台回源），
  // 这里在后台跑完后自己再取一次把新数据换上去；最多补 10 次（约 30 秒），不无限轮询。
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
    if (state.loading) return; // 用户正在切换区间，这次就不插队了
    pollCount += 1;
    try {
      const res = await fetch(API + '?' + queryString(false), { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const json = await res.json();
      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);
    } catch (e) {
      // 轮询失败不打扰用户，下次操作会重新取数
    }
  }

  /* ---------------- 启动 ---------------- */

  (async function boot() {
    loadPref();
    setStatus('正在连接本地服务…');
    hintSlow();
    try {
      const json = await fetchData(false);
      buildRangeSelect(json.presets);
      syncQuery();
      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);
      if (json.history) {
        el.from.min = json.history.month;
        el.to.max = json.expectedMonth;
        if (state.range === 'custom' && isMonth(state.from) && isMonth(state.to)) {
          el.from.value = state.from;
          el.to.value = state.to;
          el.customBox.hidden = false;
        } else {
          el.from.value = json.range.from;
          el.to.value = json.range.to;
        }
      }
    } catch (e) {
      setStatus('加载失败：' + (e.message || e) + '（确认本地服务已启动）', 'error');
      CHART_IDS.forEach((id) => emptyChart(id, '加载失败'));
    } finally {
      clearHint();
    }
  })();
})();
