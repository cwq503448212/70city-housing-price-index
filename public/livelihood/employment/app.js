'use strict';

/**
 * 中国就业形势看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/livelihood/employment?range=...
 * 时间范围只作用于月度序列（2018-01 起）；年度序列固定画全历史，不受区间影响。
 *
 * 口径铁律（与页脚一致，改前端别改口径）：
 *   - 失业率、周工时、农民工规模与收入都是统计局发布的官方原值；
 *   - 31 城差值、青年差值、外出占比、收入同比是计算值，图上与表头都标「计算」；
 *   - 16—24 岁 2023-07 ~ 2023-11 暂停发布、2023-12 起换「不含在校生」口径，两段不拼接；
 *   - 25—59 岁旧口径 2023-06 后停更，不延伸到新口径；
 *   - 登记失业率官方止于 2021 年，不补、不外推；
 *   - 缺失就是缺失，画成空点，不补 0。
 */

(function () {
  // 6 个 KPI：delta 一律取「上年同月 / 上一年」的点，现算差值，不读上游同比
  const KPI_LIST = [
    { id: 'unemployment', prevLabel: '较上年同期', deltaUnit: '个百分点' },
    { id: 'unemployment_city31', prevLabel: '较上年同期', deltaUnit: '个百分点' },
    { id: 'youth_unemployment', prevLabel: '较上年同期', deltaUnit: '个百分点' },
    { id: 'weekly_hours', prevLabel: '较上年同期', deltaUnit: '小时' },
    { id: 'migrant_income', prevLabel: '较上年', deltaUnit: '元' },
    { id: 'migrant_total', prevLabel: '较上年', deltaUnit: '万人' },
  ];

  // 月度明细表列（顺序必须与 index.html 的 thead 一致）
  const COLS_MONTH = [
    'unemployment',
    'unemployment_city31',
    'gap_city',
    'unemployment_local',
    'unemployment_migrant',
    'youth_unemployment',
    'age_25_29',
    'age_30_59',
    'gap_youth',
    'weekly_hours',
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
  const RANGE_KEY = 'livelihood.employment.range.v1';
  const DEFAULT_RANGE = '5';
  const API = '/api/livelihood/employment';

  const CHART_IDS = [
    'chart-line',
    'chart-hukou',
    'chart-age',
    'chart-hours',
    'chart-migrant',
    'chart-pay',
    'chart-registered',
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
    monthTable: $('detail-month').querySelector('tbody'),
    yearTable: $('detail-year').querySelector('tbody'),
    footMeta: $('foot-meta'),
  };

  /* ---------------- 本地偏好 ---------------- */

  function isMonth(v) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(v || '');
  }

  function loadPref() {
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

  /** '2026-09' → '2026 年 9 月' */
  function monthCn(key) {
    if (!key) return '—';
    return key.slice(0, 4) + ' 年 ' + Number(key.slice(5, 7)) + ' 月';
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

  /** 月度横轴：取全国失业率的期别（所有月度序列共用同一区间） */
  function monthsOf() {
    const ind = byId('unemployment') || (state.data && state.data.indicators[0]);
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
    return line(name, values, color, Object.assign({ yAxisIndex: 1, lineStyle: { width: 1.6, color: color, type: 'dashed' } }, extra || {}));
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

  function renderLine() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-line', '暂无数据');
    const option = base('month', true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 1) + '%', true);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 1));
    option.tooltip.formatter = makeTooltip(months, [
      { suffix: '%' },
      { suffix: '%' },
      { suffix: ' 个百分点' },
    ], 'month');
    option.series = [
      line('全国城镇调查失业率', seriesAt(months, 'unemployment'), COLOR.accent),
      line('31 个大城市', seriesAt(months, 'unemployment_city31'), COLOR.teal),
      dashed('31 城 − 全国（计算）', seriesAt(months, 'gap_city'), COLOR.amber),
    ];
    apply('chart-line', option);
  }

  function renderHukou() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-hukou', '暂无数据');
    const option = base('month', false);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 1) + '%', true);
    option.tooltip.formatter = makeTooltip(months, [{ suffix: '%' }, { suffix: '%' }], 'month');
    option.series = [
      line('本地户籍劳动力', seriesAt(months, 'unemployment_local'), COLOR.accent),
      line('外来户籍劳动力', seriesAt(months, 'unemployment_migrant'), COLOR.amber),
    ];
    apply('chart-hukou', option);
  }

  function renderAge() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-age', '暂无数据');
    const option = base('month', false);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 1) + '%', true);
    option.tooltip.formatter = makeTooltip(
      months,
      [{ suffix: '%' }, { suffix: '%' }, { suffix: '%' }, { suffix: '%' }],
      'month'
    );

    const youthExtra = {};
    if (months.indexOf('2023-12') >= 0) {
      youthExtra.markLine = {
        silent: true,
        symbol: 'none',
        label: {
          formatter: '2023-12 起不含在校生',
          color: COLOR.muted,
          fontSize: 11,
          position: 'insideEndTop',
        },
        lineStyle: { color: COLOR.flat, type: 'dashed', width: 1 },
        data: [{ xAxis: '2023-12' }],
      };
    }
    const areaStart = months.indexOf('2023-07');
    if (areaStart >= 0) {
      const areaEnd = months.indexOf('2023-12') >= 0 ? '2023-12' : months[months.length - 1];
      youthExtra.markArea = {
        silent: true,
        itemStyle: { color: 'rgba(152,161,174,0.12)' },
        label: {
          show: true,
          formatter: '暂停发布',
          color: COLOR.muted,
          fontSize: 11,
          position: 'insideTop',
        },
        data: [[{ xAxis: '2023-07' }, { xAxis: areaEnd }]],
      };
    }

    option.series = [
      line('16—24 岁', seriesAt(months, 'youth_unemployment'), COLOR.up, youthExtra),
      line('25—29 岁', seriesAt(months, 'age_25_29'), COLOR.amber),
      line('30—59 岁', seriesAt(months, 'age_30_59'), COLOR.teal),
      line('25—59 岁（旧口径，2023-06 停更）', seriesAt(months, 'age_25_59'), COLOR.flat, {
        lineStyle: { width: 1.6, color: COLOR.flat, type: 'dotted' },
      }),
    ];
    apply('chart-age', option);
  }

  function renderHours() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-hours', '暂无数据');
    const option = base('month', false);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 1) + ' 小时', false);
    option.tooltip.formatter = makeTooltip(months, [{ suffix: ' 小时' }], 'month');
    option.series = [
      line('周平均工作时间', seriesAt(months, 'weekly_hours'), COLOR.violet, {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(124,58,237,0.16)' },
              { offset: 1, color: 'rgba(124,58,237,0.01)' },
            ],
          },
        },
        markLine: hLine(48, '48 小时 ≈ 每周 6 天 × 8 小时'),
      }),
    ];
    apply('chart-hours', option);
  }

  function renderMigrant() {
    const years = yearsOf(['migrant_total', 'migrant_local', 'migrant_out', 'migrant_out_share']);
    if (!years.length) return emptyChart('chart-migrant', '暂无数据');
    const option = base('year', true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 1) + '%');
    option.tooltip.formatter = makeTooltip(
      years,
      [{ suffix: ' 万人', decimals: 0 }, { suffix: ' 万人', decimals: 0 }, { suffix: '%' }],
      'year'
    );
    option.series = [
      bar('本地农民工', seriesAt(years, 'migrant_local'), COLOR.accent, {
        stack: 'total',
        itemStyle: { color: COLOR.accent, borderRadius: [0, 0, 0, 0] },
      }),
      bar('外出农民工', seriesAt(years, 'migrant_out'), COLOR.amberLight, {
        stack: 'total',
        itemStyle: { color: COLOR.amberLight, borderRadius: [2, 2, 0, 0] },
      }),
      dashed('外出占比（计算）', seriesAt(years, 'migrant_out_share'), COLOR.violet),
    ];
    apply('chart-migrant', option);
  }

  function renderPay() {
    const years = yearsOf(['migrant_income']);
    if (!years.length) return emptyChart('chart-pay', '暂无数据');
    const incomes = seriesAt(years, 'migrant_income');
    // 收入同比：本页计算，今年 ÷ 上年 − 1；缺任一年就是 null
    const growth = incomes.map((v, i) => {
      const prev = i > 0 ? incomes[i - 1] : null;
      if (v === null || prev === null || prev === 0) return null;
      return Number((((v - prev) / prev) * 100).toFixed(1));
    });
    const option = base('year', true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 1) + '%');
    option.tooltip.formatter = makeTooltip(
      years,
      [{ suffix: ' 元', decimals: 0 }, { suffix: '%' }],
      'year'
    );
    option.series = [
      bar('月均收入（名义）', incomes, COLOR.accent),
      dashed('收入同比（计算）', growth, COLOR.teal),
    ];
    apply('chart-pay', option);
  }

  function renderRegistered() {
    const years = yearsOf(['registered_unemployed', 'registered_rate']);
    if (!years.length) return emptyChart('chart-registered', '暂无数据');
    const option = base('year', true);
    option.xAxis.data = years;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => fmtNum(v, 1) + '%');
    option.tooltip.formatter = makeTooltip(
      years,
      [{ suffix: ' 万人', decimals: 0 }, { suffix: '%' }],
      'year'
    );
    option.series = [
      bar('登记失业人数', seriesAt(years, 'registered_unemployed'), COLOR.accentLight, {
        barMaxWidth: 14,
      }),
      line('登记失业率（止于 2021）', seriesAt(years, 'registered_rate'), COLOR.up, {
        yAxisIndex: 1,
        showSymbol: false,
      }),
    ];
    apply('chart-registered', option);
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
      if (ind.archived) label.appendChild(node('span', 'tag info', '已停更'));
      if (ind.stale) label.appendChild(node('span', 'tag warn', '待更新'));
      card.appendChild(label);

      const value = node('div', 'kpi-value');
      value.appendChild(document.createTextNode(fmtNum(latest.value, ind.decimals)));
      value.appendChild(node('small', '', ind.unit));
      card.appendChild(value);

      const foot = node('div', 'kpi-foot');
      foot.appendChild(node('span', '', periodCn(latest.period, ind.freq)));

      const prevKey = prevPeriod(latest.period, ind.freq);
      const prev = pointAt(cfg.id, prevKey);
      if (prev === null) {
        foot.appendChild(node('span', 'kpi-delta flat', cfg.prevLabel + ' —'));
      } else {
        const delta = Number((latest.value - prev).toFixed(Math.max(ind.decimals || 1, 1)));
        foot.appendChild(node('span', 'kpi-delta ' + signClass(delta), cfg.prevLabel + ' ' + fmtSigned(delta, ind.decimals || 1) + ' ' + cfg.deltaUnit));
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

  function avgOf(id, periods) {
    const vals = periods.map((p) => pointAt(id, p)).filter((v) => v !== null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  function renderMonthTable() {
    if (!state.data) return;
    el.monthTable.replaceChildren();
    const cols = COLS_MONTH.length + 1;

    groupedMonths().forEach((group) => {
      const avg = avgOf('unemployment', group.months);

      const head = document.createElement('tr');
      head.className = 'group-row';
      const headCell = cell(
        group.year +
          ' 年　·　' +
          group.months.length +
          ' 个月' +
          (avg === null ? '' : '　·　区间均值（全国失业率）' + fmtNum(avg, 1) + '%')
      );
      headCell.colSpan = cols;
      head.appendChild(headCell);
      el.monthTable.appendChild(head);

      group.months.forEach((month) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(monthCn(month)));
        COLS_MONTH.forEach((id) => {
          const v = pointAt(id, month);
          tr.appendChild(cell(fmtNum(v, 1), 'num'));
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
    const years = yearsOf(['migrant_total', 'migrant_income', 'registered_unemployed', 'registered_rate'])
      .slice()
      .reverse();

    years.forEach((year) => {
      const income = pointAt('migrant_income', year);
      const prevIncome = pointAt('migrant_income', String(Number(year) - 1));
      const growth =
        income === null || prevIncome === null || prevIncome === 0
          ? null
          : Number((((income - prevIncome) / prevIncome) * 100).toFixed(1));

      const tr = document.createElement('tr');
      tr.appendChild(cell(yearCn(year)));
      tr.appendChild(cell(fmtNum(pointAt('migrant_total', year), 0), 'num'));
      tr.appendChild(cell(fmtNum(pointAt('migrant_local', year), 0), 'num'));
      tr.appendChild(cell(fmtNum(pointAt('migrant_out', year), 0), 'num'));
      tr.appendChild(cell(fmtNum(pointAt('migrant_cross_province', year), 0), 'num'));
      tr.appendChild(cell(fmtNum(pointAt('migrant_out_share', year), 1), 'num'));
      tr.appendChild(cell(fmtNum(income, 0), 'num'));

      const growthCell = cell(growth === null ? '—' : fmtSigned(growth, 1), 'num' + (growth === null ? '' : ' ' + signClass(growth)));
      tr.appendChild(growthCell);

      tr.appendChild(cell(fmtNum(pointAt('registered_unemployed', year), 0), 'num'));
      tr.appendChild(cell(fmtNum(pointAt('registered_rate', year), 1), 'num'));
      el.yearTable.appendChild(tr);
    });

    if (!el.yearTable.children.length) {
      const tr = document.createElement('tr');
      const td = cell('暂无数据');
      td.colSpan = 10;
      tr.appendChild(td);
      el.yearTable.appendChild(tr);
    }
  }

  /* ---------------- 状态栏 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.title = text;
  }

  // 首次运行要拉 3 个栏目：超过 3 秒还没回来就换一句提示，避免用户以为卡住
  let slowHintTimer = null;

  function hintSlow() {
    clearTimeout(slowHintTimer);
    if (state.data) return;
    slowHintTimer = setTimeout(function () {
      setStatus('首次运行或缓存落后，正在向统计局补齐数据，约需十几秒…');
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
      ' 个月；最新月度 ' +
      (d.latestMonth || '—') +
      '，应发布到 ' +
      (d.expectedMonth || '—') +
      '（统计局每月 15 日左右发布上月数据）；年度最新 ' +
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
    renderLine();
    renderHukou();
    renderAge();
    renderHours();
    renderMigrant();
    renderPay();
    renderRegistered();
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
      if (isMonth(state.from) && isMonth(state.to)) load(false);
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
    if (state.range === 'custom' && isMonth(state.from) && isMonth(state.to)) load(false);
  });

  el.to.addEventListener('change', () => {
    state.to = el.to.value;
    savePref();
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
