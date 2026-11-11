'use strict';

/**
 * 中国社会保障看板 · 养老医保 —— 前端渲染
 *
 * 数据只有一次请求：/api/livelihood/security?range=...
 * 全部是年度序列，时间范围按年生效；每个点就是一年。
 *
 * 口径铁律（与页脚一致，改前端别改口径）：
 *   - 基金收入 / 支出 / 累计结余、参保人数、待遇人数都是统计局发布的官方原值；
 *   - 当期结余、人均养老金支出、可支付月数、五个参保率是计算值，图上与表头都标「计算」；
 *   - 生育保险基金止于 2018、待遇人数止于 2021，按归档处理，不算滞后、不往后延伸；
 *   - 医保全口径参保人数 2017 年起才有，不跨断点拼接；
 *   - 参保率：职工养老 / 失业 / 工伤 / 生育分母取城镇就业人员（职工养老分子用「在职」参保，避免算出 113% 的假数），
 *     医保分母取年末总人口（全口径参保覆盖全体国民，除城镇就业会算出 280%）；
 *   - 缺失就是缺失，画成空点，不补 0。
 */

(function () {
  // 6 个 KPI：delta 一律取「上一年」的点现算差值，不读上游同比
  const KPI_LIST = [
    { id: 'fund_total_in', prevLabel: '较上年', deltaUnit: '亿元' },
    { id: 'fund_total_out', prevLabel: '较上年', deltaUnit: '亿元' },
    { id: 'fund_total_gap', prevLabel: '较上年', deltaUnit: '亿元' },
    { id: 'fund_total_balance', prevLabel: '较上年', deltaUnit: '亿元' },
    { id: 'worker_coverage', prevLabel: '较上年', deltaUnit: '个百分点' },
    { id: 'med_coverage', prevLabel: '较上年', deltaUnit: '个百分点' },
  ];

  // 5 张明细表的列（顺序即表头顺序，id 必须存在于 config/security.json）
  const TABLES = [
    {
      id: 't-fund',
      ids: [
        'fund_total_in',
        'fund_total_out',
        'fund_total_gap',
        'fund_total_balance',
        'fund_pension_in',
        'fund_pension_out',
        'fund_pension_gap',
        'fund_pension_balance',
        'fund_medical_in',
        'fund_medical_out',
        'fund_medical_gap',
        'fund_medical_balance',
        'fund_unemp_in',
        'fund_unemp_out',
        'fund_unemp_gap',
        'fund_unemp_balance',
        'fund_injury_in',
        'fund_injury_out',
        'fund_injury_gap',
        'fund_injury_balance',
        'fund_mat_in',
        'fund_mat_out',
        'fund_mat_gap',
        'fund_mat_balance',
      ],
    },
    {
      id: 't-pension',
      ids: [
        'worker_insured',
        'worker_active',
        'worker_retired',
        'worker_retiree_ratio',
        'worker_coverage',
        'fund_pension_in',
        'fund_pension_out',
        'fund_pension_balance',
        'worker_pension_per_capita',
        'worker_pay_months',
      ],
    },
    {
      id: 't-resident',
      ids: [
        'resident_insured',
        'resident_beneficiaries',
        'resident_beneficiary_ratio',
        'resident_in',
        'resident_out',
        'resident_balance',
        'resident_pension_per_capita',
        'resident_pay_months',
      ],
    },
    {
      id: 't-medical',
      ids: [
        'med_insured',
        'med_employee',
        'med_active',
        'med_retired',
        'med_resident',
        'med_coverage',
        'med_employee_in',
        'med_employee_out',
        'med_employee_gap',
        'med_employee_balance',
        'med_resident_in',
        'med_resident_out',
        'med_resident_gap',
        'med_resident_balance',
        'med_pay_months',
      ],
    },
    {
      id: 't-others',
      ids: [
        'unemp_insured',
        'unemp_beneficiaries',
        'unemp_benefit_ratio',
        'unemp_pay_months',
        'unemp_coverage',
        'injury_insured',
        'injury_beneficiaries',
        'injury_benefit_ratio',
        'injury_pay_months',
        'injury_coverage',
        'mat_insured',
        'mat_beneficiaries',
        'mat_coverage',
      ],
    },
  ];

  const COLOR = {
    ink: '#16181d',
    muted: '#7b8391',
    line: '#e8eaee',
    lineStrong: '#d9dce2',
    accent: '#175cd3',
    accentLight: '#5b8def',
    teal: '#0e7490',
    tealLight: '#22b8cf',
    amber: '#b45309',
    amberLight: '#d97706',
    violet: '#7c3aed',
    rose: '#be123c',
    up: '#d14343',
    down: '#1f9254',
    flat: '#98a1ae',
  };

  // 用户可选的时间范围存本地：改默认值时必须同时升级这个键名（v1 -> v2）
  const RANGE_KEY = 'livelihood.security.range.v1';
  const DEFAULT_RANGE = '10';
  const API = '/api/livelihood/security';

  const CHART_IDS = [
    'chart-fund',
    'chart-pension',
    'chart-resident',
    'chart-medical',
    'chart-others',
    'chart-insured',
    'chart-coverage',
    'chart-benefit',
    'chart-months',
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
    refresh: $('refresh'),
    status: $('status'),
    rangeHint: $('range-hint'),
    kpiRow: $('kpi-row'),
    footMeta: $('foot-meta'),
  };

  /* ---------------- 本地偏好 ---------------- */

  function isYear(v) {
    return /^\d{4}$/.test(v || '');
  }

  function loadPref() {
    try {
      const raw = localStorage.getItem(RANGE_KEY);
      if (!raw) return;
      const pref = JSON.parse(raw);
      if (!pref) return;
      if (pref.range === 'custom') {
        if (isYear(pref.from) && isYear(pref.to)) {
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

  /** '2025' → '2025 年' */
  function yearCn(key) {
    return key ? key + ' 年' : '—';
  }

  function prevYear(key) {
    return key ? String(Number(key) - 1) : '';
  }

  /* ---------------- 数据访问 ---------------- */

  function byId(id) {
    if (!state.data) return null;
    return state.data.indicators.filter((x) => x.id === id)[0] || null;
  }

  function pointsOf(id) {
    const ind = byId(id);
    return ind ? ind.points : [];
  }

  /** 给定指标各自期别的并集，升序 */
  function yearsOf(ids) {
    const set = new Set();
    ids.forEach((id) => {
      pointsOf(id).forEach((p) => {
        if (p.value !== null) set.add(p.period);
      });
    });
    return Array.from(set).sort();
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
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: formatter || ((v) => fmtNum(v, 1)) },
      splitLine: { show: false },
    };
  }

  function base(dual) {
    const option = {
      animationDuration: 420,
      grid: { left: 8, right: 8, top: 46, bottom: 26, containLabel: true },
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
        left: 0,
        right: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: COLOR.muted, fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        boundaryGap: true,
        axisLine: { lineStyle: { color: COLOR.lineStrong } },
        axisTick: { show: false },
        axisLabel: { color: COLOR.muted, fontSize: 11, hideOverlap: true },
      },
      yAxis: [leftAxis()],
    };
    if (dual) option.yAxis.push(rightAxis());
    return option;
  }

  /** tooltip：按 seriesIndex 取单位与小数位 */
  function makeTooltip(periods, specs) {
    return (params) => {
      if (!params || !params.length) return '';
      const head = yearCn(periods[params[0].dataIndex]);
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

  function dashed(name, values, color, extra) {
    return line(name, values, color, Object.assign({ yAxisIndex: 1, lineStyle: { width: 1.6, color: color, type: 'dashed' } }, extra || {}));
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

  function hLine(value, label) {
    return {
      silent: true,
      symbol: 'none',
      label: { formatter: label, color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
      lineStyle: { color: COLOR.flat, type: 'dashed', width: 1 },
      data: [{ yAxis: value }],
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

  /* ---------------- 各图 ---------------- */

  function renderFund() {
    const ids = ['fund_total_in', 'fund_total_out', 'fund_total_balance'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-fund', '暂无数据');
    const option = base(true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
    ]);
    option.series = [
      bar('当年收入', seriesAt(years, 'fund_total_in'), COLOR.accent),
      bar('当年支出', seriesAt(years, 'fund_total_out'), COLOR.amberLight),
      dashed('累计结余（右轴）', seriesAt(years, 'fund_total_balance'), COLOR.teal),
    ];
    apply('chart-fund', option);
  }

  function renderPension() {
    const ids = ['fund_pension_in', 'fund_pension_out', 'fund_pension_balance'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-pension', '暂无数据');
    const option = base(true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
    ]);
    option.series = [
      bar('当年收入', seriesAt(years, 'fund_pension_in'), COLOR.accent),
      bar('当年支出', seriesAt(years, 'fund_pension_out'), COLOR.amberLight),
      dashed('累计结余（右轴）', seriesAt(years, 'fund_pension_balance'), COLOR.teal),
    ];
    apply('chart-pension', option);
  }

  function renderResident() {
    const ids = ['resident_in', 'resident_out', 'resident_balance'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-resident', '暂无数据');
    const option = base(true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 0));
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
    ]);
    option.series = [
      bar('当年收入', seriesAt(years, 'resident_in'), COLOR.accent),
      bar('当年支出', seriesAt(years, 'resident_out'), COLOR.amberLight),
      dashed('累计结余（右轴）', seriesAt(years, 'resident_balance'), COLOR.teal),
    ];
    apply('chart-resident', option);
  }

  function renderMedical() {
    const ids = ['med_employee_in', 'med_employee_out', 'med_resident_in', 'med_resident_out'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-medical', '暂无数据');
    const option = base(false);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
      { suffix: ' 亿元', decimals: 1 },
    ]);
    option.series = [
      bar('职工医保收入', seriesAt(years, 'med_employee_in'), COLOR.accent),
      bar('职工医保支出', seriesAt(years, 'med_employee_out'), COLOR.accentLight),
      bar('居民医保收入', seriesAt(years, 'med_resident_in'), COLOR.teal),
      bar('居民医保支出', seriesAt(years, 'med_resident_out'), COLOR.tealLight),
    ];
    apply('chart-medical', option);
  }

  function renderOthers() {
    const ids = ['fund_unemp_gap', 'fund_injury_gap', 'fund_mat_gap'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-others', '暂无数据');
    const option = base(false);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), true);
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 亿元' },
      { suffix: ' 亿元' },
      { suffix: ' 亿元' },
    ]);
    option.series = [
      line('失业保险当年结余', seriesAt(years, 'fund_unemp_gap'), COLOR.accent),
      line('工伤保险当年结余', seriesAt(years, 'fund_injury_gap'), COLOR.teal),
      line('生育保险当年结余（止于 2018）', seriesAt(years, 'fund_mat_gap'), COLOR.flat, {
        lineStyle: { width: 1.6, color: COLOR.flat, type: 'dotted' },
      }),
    ];
    apply('chart-others', option);
  }

  function renderInsured() {
    const ids = ['worker_insured', 'resident_insured', 'med_insured', 'unemp_insured', 'injury_insured', 'mat_insured'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-insured', '暂无数据');
    const option = base(false);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 万人', decimals: 0 },
      { suffix: ' 万人', decimals: 0 },
      { suffix: ' 万人', decimals: 0 },
      { suffix: ' 万人', decimals: 0 },
      { suffix: ' 万人', decimals: 0 },
      { suffix: ' 万人', decimals: 0 },
    ]);
    option.series = [
      line('职工养老（含离退休）', seriesAt(years, 'worker_insured'), COLOR.accent),
      line('城乡居民养老', seriesAt(years, 'resident_insured'), COLOR.accentLight),
      line('基本医保（全口径）', seriesAt(years, 'med_insured'), COLOR.teal),
      line('失业保险', seriesAt(years, 'unemp_insured'), COLOR.amber),
      line('工伤保险', seriesAt(years, 'injury_insured'), COLOR.violet),
      line('生育保险', seriesAt(years, 'mat_insured'), COLOR.rose),
    ];
    apply('chart-insured', option);
  }

  function renderCoverage() {
    const ids = ['worker_coverage', 'med_coverage', 'unemp_coverage', 'injury_coverage', 'mat_coverage'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-coverage', '暂无数据');
    const option = base(false);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0) + '%', false);
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: '%' },
      { suffix: '%' },
      { suffix: '%' },
      { suffix: '%' },
      { suffix: '%' },
    ]);
    option.series = [
      line('职工养老（在职 ÷ 城镇就业）', seriesAt(years, 'worker_coverage'), COLOR.accent),
      line('基本医保（÷ 年末总人口）', seriesAt(years, 'med_coverage'), COLOR.teal),
      line('失业保险（÷ 城镇就业）', seriesAt(years, 'unemp_coverage'), COLOR.amber),
      line('工伤保险（÷ 城镇就业）', seriesAt(years, 'injury_coverage'), COLOR.violet),
      line('生育保险（÷ 城镇就业）', seriesAt(years, 'mat_coverage'), COLOR.rose),
    ];
    apply('chart-coverage', option);
  }

  function renderBenefit() {
    const ids = ['worker_pension_per_capita', 'resident_pension_per_capita'];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-benefit', '暂无数据');
    const option = base(false);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 元 / 人 / 年', decimals: 0 },
      { suffix: ' 元 / 人 / 年', decimals: 0 },
    ]);
    option.series = [
      line('城镇职工', seriesAt(years, 'worker_pension_per_capita'), COLOR.accent),
      line('城乡居民', seriesAt(years, 'resident_pension_per_capita'), COLOR.amber),
    ];
    apply('chart-benefit', option);
  }

  function renderMonths() {
    const ids = [
      'worker_pay_months',
      'resident_pay_months',
      'med_pay_months',
      'unemp_pay_months',
      'injury_pay_months',
    ];
    const years = yearsOf(ids);
    if (!years.length) return emptyChart('chart-months', '暂无数据');
    const option = base(false);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0) + ' 月', false);
    option.tooltip.formatter = makeTooltip(years, [
      { suffix: ' 个月' },
      { suffix: ' 个月' },
      { suffix: ' 个月' },
      { suffix: ' 个月' },
      { suffix: ' 个月' },
    ]);
    option.series = [
      line('城镇职工养老', seriesAt(years, 'worker_pay_months'), COLOR.accent, {
        markLine: hLine(12, '12 个月 ≈ 一年安全垫'),
      }),
      line('城乡居民养老', seriesAt(years, 'resident_pay_months'), COLOR.amber),
      line('基本医疗保险', seriesAt(years, 'med_pay_months'), COLOR.teal),
      line('失业保险', seriesAt(years, 'unemp_pay_months'), COLOR.violet),
      line('工伤保险', seriesAt(years, 'injury_pay_months'), COLOR.rose),
    ];
    apply('chart-months', option);
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
      label.appendChild(node('span', 'tag', '年度'));
      if (ind.computed) label.appendChild(node('span', 'tag', '计算值'));
      if (ind.archived) label.appendChild(node('span', 'tag info', '已停更'));
      if (ind.stale) label.appendChild(node('span', 'tag warn', '待更新'));
      card.appendChild(label);

      const value = node('div', 'kpi-value');
      value.appendChild(document.createTextNode(fmtNum(latest.value, ind.decimals)));
      value.appendChild(node('small', '', ind.unit));
      card.appendChild(value);

      const foot = node('div', 'kpi-foot');
      foot.appendChild(node('span', '', yearCn(latest.period)));

      const prev = pointAt(cfg.id, prevYear(latest.period));
      if (prev === null) {
        foot.appendChild(node('span', 'kpi-delta flat', cfg.prevLabel + ' —'));
      } else {
        const d = Math.max(ind.decimals || 1, 1);
        const delta = Number((latest.value - prev).toFixed(d));
        foot.appendChild(
          node('span', 'kpi-delta ' + signClass(delta), cfg.prevLabel + ' ' + fmtSigned(delta, d) + ' ' + cfg.deltaUnit)
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

  function renderTable(def) {
    const table = document.getElementById(def.id);
    if (!table || !state.data) return;
    table.replaceChildren();

    const cols = def.ids.map((id) => byId(id)).filter(Boolean);
    if (!cols.length) {
      const tr = document.createElement('tr');
      const td = cell('暂无数据');
      td.colSpan = 2;
      tr.appendChild(td);
      table.appendChild(tr);
      return;
    }

    // 表头：短名 + 单位；计算值额外标「计算」，归档序列标「止于 XXXX」
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(node('th', '', '年份'));
    cols.forEach((ind) => {
      const th = document.createElement('th');
      th.className = 'num';
      th.appendChild(document.createTextNode(ind.shortLabel || ind.label));
      const unit = ind.unit + (ind.computed ? ' · 计算' : '') + (ind.until ? ' · 止于 ' + ind.until : '');
      th.appendChild(node('small', '', unit));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const years = yearsOf(cols.map((x) => x.id)).slice().reverse();
    years.forEach((year) => {
      const tr = document.createElement('tr');
      tr.appendChild(cell(yearCn(year)));
      cols.forEach((ind) => {
        const v = pointAt(ind.id, year);
        tr.appendChild(cell(fmtNum(v, ind.decimals), 'num'));
      });
      tbody.appendChild(tr);
    });
    if (!years.length) {
      const tr = document.createElement('tr');
      const td = cell('暂无数据');
      td.colSpan = cols.length + 1;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  /* ---------------- 状态栏 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.title = text;
  }

  // 首次运行要拉 9 个栏目：超过 3 秒还没回来就换一句提示，避免用户以为卡住
  let slowHintTimer = null;

  function hintSlow() {
    clearTimeout(slowHintTimer);
    if (state.data) return;
    slowHintTimer = setTimeout(function () {
      setStatus('首次运行或缓存落后，正在向统计局补齐九张年度表，约需十几秒…');
    }, 3000);
  }

  function clearHint() {
    clearTimeout(slowHintTimer);
  }

  /** 状态栏只看服务端给的 stale / errors / expectedYear，不自己猜年份 */
  function applyStatus(json) {
    const staleList = json.indicators.filter((x) => x.stale);
    const busy = json.refreshing ? '（后台补齐中…）' : '';

    if (json.errors && json.errors.length) {
      setStatus('上游异常，已回退本地缓存（' + staleList.length + ' 项待更新）' + busy, 'warn');
      el.status.title = json.errors.join('\n');
      return;
    }
    if (!staleList.length) {
      const first = json.firstRun ? '　首次运行已把全部历史写入缓存' : '';
      setStatus(
        '数据完整　最新年度 ' +
          (json.latestYear || '—') +
          '（应发布 ' +
          (json.expectedYear || '—') +
          '）' +
          (json.fetched ? '　本次回源 ' + json.fetched + ' 个栏目' : '　全部命中本地缓存') +
          busy +
          first,
        'ok'
      );
      return;
    }
    // 社保各险种的收支比合计慢一年是常态，这里按「最新年度」说人话，不说「数据过期」
    const years = staleList.map((x) => x.latestCached).filter(Boolean).sort();
    const oldest = years.length ? years[0] : '—';
    const newest = years.length ? years[years.length - 1] : '—';
    setStatus(
      '已有 ' +
        (json.latestYear || '—') +
        ' 年数据　' +
        staleList.length +
        ' 项最新为 ' +
        (oldest === newest ? oldest : oldest + '—' + newest) +
        ' 年（应发布 ' +
        (json.expectedYear || '—') +
        '，尚未入库）' +
        busy,
      'warn'
    );
  }

  function renderMeta() {
    const d = state.data;
    if (!d) return;
    el.rangeHint.textContent =
      '当前区间：' +
      yearCn(d.range.from) +
      ' ~ ' +
      yearCn(d.range.to) +
      '　' +
      d.range.label +
      '　共 ' +
      yearsOf(d.indicators.map((x) => x.id)).length +
      ' 个年度点；最新年度 ' +
      (d.latestYear || '—') +
      '，应发布到 ' +
      (d.expectedYear || '—') +
      '（社保基金收支通常在次年 9—12 月随《中国统计年鉴》入库）';

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
      ' 个数据点，覆盖 ' +
      d.cache.years +
      ' 个年度，最新 ' +
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
    renderFund();
    renderPension();
    renderResident();
    renderMedical();
    renderOthers();
    renderInsured();
    renderCoverage();
    renderBenefit();
    renderMonths();
    TABLES.forEach(renderTable);
    renderMeta();
  }

  /* ---------------- 交互 ---------------- */

  function syncInputs(json) {
    if (!json || !json.history) return;
    el.from.min = json.history.from;
    el.to.max = json.expectedYear;
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
    custom.textContent = '自定义年份';
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
      if (isYear(state.from) && isYear(state.to)) load(false);
      return;
    }
    state.from = '';
    state.to = '';
    savePref();
    load(false);
  });

  el.from.addEventListener('change', () => {
    state.from = el.from.value;
    savePref();
    if (state.range === 'custom' && isYear(state.from) && isYear(state.to)) load(false);
  });

  el.to.addEventListener('change', () => {
    state.to = el.to.value;
    savePref();
    if (state.range === 'custom' && isYear(state.from) && isYear(state.to)) load(false);
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
      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);
      if (json.history) {
        el.from.min = json.history.from;
        el.to.max = json.expectedYear;
        if (state.range === 'custom' && isYear(state.from) && isYear(state.to)) {
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
