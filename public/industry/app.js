'use strict';

/**
 * 中国工业行业运行看板
 *
 * 数据全部来自服务端 /api/industry（服务端代取 + JSON 缓存），前端不直连统计局。
 * 四块内容各看各的口径，不做任何换算与合成：
 *   热力图 / 排行  工业增加值当月同比（0 = 持平，1、2 月合并公布）
 *   四象限         营业收入与利润总额的累计同比（同一行业取两条序列共同的最新月份）
 *   PMI            扩散指数（50 = 荣枯线），与上面三类量纲不同
 */

const RANGE_KEY = 'industry.range.v1';

const COLOR = {
  up: '#d14343',
  down: '#1f9254',
  flat: '#98a1ae',
  accent: '#175cd3',
  ink: '#16181d',
  ink2: '#48505e',
  muted: '#7b8391',
  grid: '#eef0f3',
};

/* 热力图色阶：低（深绿）→ 持平（灰白）→ 高（深红），国内习惯红涨绿跌 */
const HEAT_COLORS = ['#12683c', '#7fbf9c', '#eef2ef', '#f4f5f7', '#eab3b3', '#b62b2b'];
const HEAT_CLAMP = 15; // 色阶两端只到 ±15%，更大的值仍按最深色显示，tooltip 显示真实值

/* 四象限：极端值（累计同比基数为极小负数时会放大到几百个百分点）不画进坐标，
   否则其余 40 个行业会挤成一点；这类行业在图注里点名，数值在明细表里 */
const QUAD_OUTLIER = 200;

const PMI_DEFAULT = ['mfg_new_orders', 'mfg_production', 'nonmfg_business', 'nonmfg_construction'];
const PMI_COLORS = ['#175cd3', '#d14343', '#1f9254', '#b45309', '#7c3aed', '#0891b2', '#be123c', '#4d7c0f', '#9333ea', '#64748b'];

const state = {
  data: null,
  range: loadRange(),
  charts: {},
  pollTimer: null,
  polls: 0,
  loading: false,
};

/* ---------------- 小工具 ---------------- */

function el(id) {
  return document.getElementById(id);
}

function fmt(v, digits) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const d = typeof digits === 'number' ? digits : 1;
  return (v > 0 ? '+' : '') + Number(v).toFixed(d);
}

function cls(v) {
  if (v === null || v === undefined || !isFinite(v)) return 'flat';
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

function span(a, b) {
  return '<span class="' + cls(a) + '">' + b + '</span>';
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** '2026-09' → '2026年9月' */
function cnMonth(m) {
  if (!m) return '—';
  const parts = String(m).split('-');
  return parts[0] + '年' + Number(parts[1]) + '月';
}

function nowMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

function loadRange() {
  // 地址栏优先：别人发来的链接要打开成他看到的那一屏
  const qsFrom = Board.qs('from');
  const qsTo = Board.qs('to');
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(qsFrom || '') && /^\d{4}-(0[1-9]|1[0-2])$/.test(qsTo || '')) {
    return { mode: 'custom', from: qsFrom, to: qsTo };
  }
  const qsMode = Board.qs('range');
  if (qsMode === 'all' || /^\d+$/.test(qsMode || '')) {
    return { mode: qsMode, from: '', to: '' };
  }
  try {
    const raw = localStorage.getItem(RANGE_KEY);
    if (!raw) return { mode: '5', from: '', to: '' };
    const obj = JSON.parse(raw);
    return {
      mode: obj && obj.mode ? String(obj.mode) : '5',
      from: obj && obj.from ? String(obj.from) : '',
      to: obj && obj.to ? String(obj.to) : '',
    };
  } catch (e) {
    return { mode: '5', from: '', to: '' };
  }
}

function saveRange() {
  try {
    localStorage.setItem(RANGE_KEY, JSON.stringify(state.range));
  } catch (e) {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
}

function queryString(force) {
  const r = state.range;
  const bits = [];
  if (r.mode === 'custom' && r.from && r.to) {
    bits.push('from=' + encodeURIComponent(r.from));
    bits.push('to=' + encodeURIComponent(r.to));
  } else {
    bits.push('range=' + encodeURIComponent(r.mode));
  }
  if (force) bits.push('force=1');
  return bits.join('&');
}

/* ---------------- 图表骨架 ---------------- */

function chartOf(id) {
  if (!state.charts[id]) {
    state.charts[id] = window.echarts.init(el(id), null, { renderer: 'canvas' });
  }
  return state.charts[id];
}

function baseGrid() {
  return { left: 12, right: 18, top: 32, bottom: 12, containLabel: true };
}

function axisStyle() {
  return {
    axisLine: { lineStyle: { color: '#d9dce2' } },
    axisTick: { show: false },
    axisLabel: { color: COLOR.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: COLOR.grid } },
  };
}

function emptyChart(id, text) {
  const chart = chartOf(id);
  chart.clear();
  chart.setOption({
    animation: false,
    title: {
      text: text || '所选区间内没有数据',
      left: 'center',
      top: 'middle',
      textStyle: { color: COLOR.muted, fontSize: 13, fontWeight: 'normal' },
    },
  });
}

function applyOption(id, option) {
  const chart = chartOf(id);
  chart.clear();
  chart.setOption(option, true);
}

/* ---------------- 数据整理 ---------------- */

/** 按分组顺序（配置里的顺序）排行业，同组保持配置顺序 */
function orderedIndustries(d) {
  const order = {};
  (d.groups || []).forEach((g, i) => {
    order[g.key] = i;
  });
  return d.industries.slice().sort((a, b) => {
    const oa = order[a.group] === undefined ? 99 : order[a.group];
    const ob = order[b.group] === undefined ? 99 : order[b.group];
    return oa - ob;
  });
}

/** 所有行业某个口径出现过的月份（已按区间裁剪，升序） */
function monthsOf(d, metric) {
  const set = {};
  d.industries.forEach((x) => {
    const map = x[metric] || {};
    Object.keys(map).forEach((m) => {
      set[m] = true;
    });
  });
  return Object.keys(set).sort();
}

/** 最新一期（增加值口径） */
function latestOutputMonth(d) {
  let m = '';
  d.industries.forEach((x) => {
    const p = x.latest && x.latest.output;
    if (p && p.month > m) m = p.month;
  });
  return m;
}

/** 某行业营收与利润共同的最新月份：保证四象限里每个点的 x、y 同期 */
function commonMonth(x) {
  const r = Object.keys(x.revenue || {});
  const p = Object.keys(x.profit || {});
  const both = r.filter((m) => p.indexOf(m) !== -1).sort();
  return both.length ? both[both.length - 1] : '';
}

/** 稳健的坐标范围：取绝对值 95 分位，向上取整到 10 的倍数 */
function robustLimit(values, floor) {
  const abs = values
    .filter((v) => v !== null && v !== undefined && isFinite(v))
    .map((v) => Math.abs(v))
    .sort((a, b) => a - b);
  if (!abs.length) return floor;
  const idx = Math.min(abs.length - 1, Math.floor(abs.length * 0.95));
  return Math.max(floor, Math.ceil((abs[idx] * 1.15) / 10) * 10);
}

/* ---------------- KPI ---------------- */

function kpiCard(label, tag, value, unit, foot) {
  return (
    '<div class="kpi">' +
    '<div class="kpi-label">' +
    label +
    (tag ? ' <span class="tag ' + tag.kind + '">' + tag.text + '</span>' : '') +
    '</div>' +
    '<div class="kpi-value">' +
    value +
    (unit ? '<small>' + unit + '</small>' : '') +
    '</div>' +
    '<div class="kpi-foot">' +
    (foot || '') +
    '</div>' +
    '</div>'
  );
}

function renderKpis(d) {
  const rows = orderedIndustries(d);
  const latestOut = latestOutputMonth(d);

  let upCount = 0;
  let downCount = 0;
  let best = null;
  let worst = null;
  rows.forEach((x) => {
    const v = latestOut ? x.output[latestOut] : undefined;
    if (v === undefined || v === null) return;
    if (v > 0) upCount += 1;
    else if (v < 0) downCount += 1;
    if (!best || v > best.value) best = { label: x.shortLabel, value: v };
    if (!worst || v < worst.value) worst = { label: x.shortLabel, value: v };
  });

  let profitUp = 0;
  let profitDown = 0;
  rows.forEach((x) => {
    const p = x.latest && x.latest.profit;
    if (!p || p.value === null || p.value === undefined) return;
    if (p.value > 0) profitUp += 1;
    else if (p.value < 0) profitDown += 1;
  });

  const noOrder = (d.pmi || []).filter((p) => p.id === 'mfg_new_orders')[0];
  const noOrderVal = noOrder && noOrder.latest ? noOrder.latest.value : null;

  const cards = [
    kpiCard(
      '最新一期',
      { kind: 'info', text: '增加值' },
      latestOut ? cnMonth(latestOut) : '—',
      '',
      '营收 / 利润 ' +
        (d.expected && d.expected.revenue ? cnMonth(d.expected.revenue) : '—') +
        '　PMI ' +
        (d.expected && d.expected.pmi ? cnMonth(d.expected.pmi) : '—')
    ),
    kpiCard(
      '增加值同比为正',
      { kind: 'ok', text: '本期' },
      upCount + '<small> / ' + rows.length + ' 个行业</small>',
      '',
      '下降 ' + downCount + ' 个' + (upCount + downCount < rows.length ? '，其余持平' : '')
    ),
    kpiCard(
      '利润累计同比为正',
      { kind: 'info', text: '各行业最新一期' },
      profitUp + '<small> / ' + rows.length + ' 个行业</small>',
      '',
      '下降 ' + profitDown + ' 个' + (profitUp + profitDown < rows.length ? '，其余持平或未发布' : '')
    ),
    kpiCard(
      '增加值最快',
      { kind: 'ok', text: latestOut ? cnMonth(latestOut) : '—' },
      best ? span(best.value, fmt(best.value)) : '—',
      '%',
      best ? escapeHtml(best.label) : '暂无数据'
    ),
    kpiCard(
      '增加值最慢',
      { kind: 'warn', text: latestOut ? cnMonth(latestOut) : '—' },
      worst ? span(worst.value, fmt(worst.value)) : '—',
      '%',
      worst ? escapeHtml(worst.label) : '暂无数据'
    ),
    kpiCard(
      '制造业 PMI · 新订单',
      { kind: 'info', text: '50 = 荣枯线' },
      noOrderVal === null ? '—' : Number(noOrderVal).toFixed(1),
      '',
      noOrderVal === null
        ? '暂无数据'
        : '<span class="kpi-delta ' +
          cls(noOrderVal - 50) +
          '">' +
          fmt(noOrderVal - 50) +
          '</span> 相对荣枯线　' +
          cnMonth(noOrder && noOrder.latest ? noOrder.latest.month : '')
    ),
  ];

  el('kpi-row').innerHTML = cards.join('');
}

/* ---------------- 热力图 ---------------- */

function renderHeat(d) {
  const rows = orderedIndustries(d);
  const months = monthsOf(d, 'output');
  if (!months.length) {
    emptyChart('chart-heat', '所选区间内没有增加值数据');
    return;
  }

  const labels = rows.map((x) => x.shortLabel);
  const data = [];
  rows.forEach((x, y) => {
    months.forEach((m, x2) => {
      const v = x.output[m];
      if (v === undefined || v === null) return;
      data.push([x2, y, v]);
    });
  });

  // 月份标签按长度抽稀，避免 60 个月挤成一片
  const interval = Math.max(0, Math.ceil(months.length / 12) - 1);

  applyOption('chart-heat', {
    animation: false,
    grid: { left: 12, right: 20, top: 10, bottom: 56, containLabel: true },
    tooltip: {
      position: 'top',
      backgroundColor: 'rgba(22, 24, 29, 0.92)',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter: function (p) {
        const item = rows[p.data[1]];
        const m = months[p.data[0]];
        const v = p.data[2];
        return (
          escapeHtml(item.label) +
          '<br/>' +
          m +
          '　<b>' +
          fmt(v) +
          '%</b>　' +
          (v > 0 ? '同比增长' : v < 0 ? '同比下降' : '持平')
        );
      },
    },
    xAxis: Object.assign({}, axisStyle(), {
      type: 'category',
      data: months,
      axisLabel: { color: COLOR.muted, fontSize: 11, interval: interval, formatter: (m) => m.slice(2) },
      splitLine: { show: false },
    }),
    yAxis: Object.assign({}, axisStyle(), {
      type: 'category',
      data: labels,
      inverse: true,
      axisLabel: { color: COLOR.ink2, fontSize: 11 },
      splitLine: { show: false },
    }),
    visualMap: {
      type: 'continuous',
      min: -HEAT_CLAMP,
      max: HEAT_CLAMP,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 4,
      itemWidth: 14,
      itemHeight: 120,
      text: ['增长 %', '下降 %'],
      textStyle: { color: COLOR.muted, fontSize: 11 },
      inRange: { color: HEAT_COLORS },
    },
    series: [
      {
        name: '增加值同比',
        type: 'heatmap',
        data: data,
        itemStyle: { borderColor: '#ffffff', borderWidth: 0.5 },
        emphasis: { itemStyle: { borderColor: COLOR.ink, borderWidth: 1 } },
        progressive: 0,
      },
    ],
  });
}

/* ---------------- 排行 ---------------- */

function renderRank(d) {
  const month = latestOutputMonth(d);
  if (!month) {
    emptyChart('chart-rank', '所选区间内没有增加值数据');
    el('rank-sub').textContent = '按最新一期工业增加值当月同比排序，红为增长、绿为下降；只列该期有值的行业';
    return;
  }

  const items = [];
  d.industries.forEach((x) => {
    const v = x.output[month];
    if (v === undefined || v === null) return;
    items.push({ label: x.shortLabel, full: x.label, value: v });
  });
  items.sort((a, b) => a.value - b.value);
  if (!items.length) {
    emptyChart('chart-rank', '所选区间内没有增加值数据');
    return;
  }

  el('rank-sub').innerHTML =
    cnMonth(month) +
    ' 当期同比（%），红为增长、绿为下降；共 ' +
    items.length +
    ' 个行业有值，其余行业该期上游未发布（1、2 月合并公布时会出现这种情况）';

  applyOption('chart-rank', {
    animation: false,
    grid: { left: 12, right: 56, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(22, 24, 29, 0.92)',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter: function (p) {
        const item = items[p.dataIndex];
        return escapeHtml(item.full) + '<br/>' + month + '　<b>' + fmt(item.value) + '%</b>';
      },
    },
    xAxis: Object.assign({}, axisStyle(), { type: 'value', axisLabel: { color: COLOR.muted, fontSize: 11, formatter: '{value}%' } }),
    yAxis: Object.assign({}, axisStyle(), {
      type: 'category',
      data: items.map((x) => x.label),
      axisLabel: { color: COLOR.ink2, fontSize: 11 },
      splitLine: { show: false },
    }),
    series: [
      {
        type: 'bar',
        barWidth: '62%',
        data: items.map((x) => ({
          value: x.value,
          itemStyle: { color: x.value > 0 ? COLOR.up : x.value < 0 ? COLOR.down : COLOR.flat, borderRadius: 2 },
        })),
        label: {
          show: true,
          position: 'right',
          fontSize: 11,
          color: COLOR.ink2,
          formatter: (p) => fmt(p.value),
        },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: COLOR.flat, width: 1, type: 'dashed' },
          data: [{ xAxis: 0 }],
        },
      },
    ],
  });
}

/* ---------------- 四象限 ---------------- */

function renderQuad(d) {
  const rows = orderedIndustries(d);
  const pts = [];
  const dropped = [];
  rows.forEach((x) => {
    const m = commonMonth(x);
    if (!m) return;
    const r = x.revenue[m];
    const p = x.profit[m];
    if (r === undefined || r === null || p === undefined || p === null) return;
    if (Math.abs(r) > QUAD_OUTLIER || Math.abs(p) > QUAD_OUTLIER) {
      dropped.push({ label: x.label, month: m, revenue: r, profit: p });
      return;
    }
    pts.push({ key: x.key, label: x.shortLabel, full: x.label, month: m, revenue: r, profit: p });
  });

  if (!pts.length) {
    emptyChart('chart-quad', '所选区间内没有营收与利润同时有值的月份');
    return;
  }

  const limX = robustLimit(pts.map((p) => p.revenue), 10);
  const limY = robustLimit(pts.map((p) => p.profit), 10);

  const note = dropped.length
    ? '；' +
      dropped
        .map((x) => escapeHtml(x.label) + '（' + x.month + ' 利润 ' + fmt(x.profit) + '%）')
        .join('、') +
      ' 数值超出坐标范围，未画入本图，见明细表'
    : '';
  el('quad-sub').innerHTML =
    '横轴为营业收入累计同比、纵轴为利润总额累计同比（%），每点一个行业，取该行业两条序列共同的最新月份；' +
    '右上「增收又增利」，右下「增收不增利」，左下「双降」' +
    note;

  applyOption('chart-quad', {
    animation: false,
    grid: { left: 12, right: 28, top: 28, bottom: 20, containLabel: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(22, 24, 29, 0.92)',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter: function (p) {
        const x = pts[p.dataIndex];
        return (
          escapeHtml(x.full) +
          '<br/>' +
          x.month +
          '<br/>营业收入累计同比　<b>' +
          fmt(x.revenue) +
          '%</b><br/>利润总额累计同比　<b>' +
          fmt(x.profit) +
          '%</b>'
        );
      },
    },
    xAxis: Object.assign({}, axisStyle(), {
      type: 'value',
      min: -limX,
      max: limX,
      name: '营收累计同比 %',
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { color: COLOR.muted, fontSize: 11 },
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: '{value}%' },
    }),
    yAxis: Object.assign({}, axisStyle(), {
      type: 'value',
      min: -limY,
      max: limY,
      name: '利润累计同比 %',
      nameTextStyle: { color: COLOR.muted, fontSize: 11 },
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: '{value}%' },
    }),
    series: [
      {
        type: 'scatter',
        symbolSize: 9,
        data: pts.map((x) => ({
          value: [x.revenue, x.profit],
          itemStyle: { color: COLOR.accent, opacity: 0.85 },
        })),
        label: {
          show: true,
          position: 'right',
          distance: 4,
          fontSize: 10,
          color: COLOR.ink2,
          formatter: (p) => pts[p.dataIndex].label,
        },
        labelLayout: { hideOverlap: true },
        emphasis: { label: { show: true, fontWeight: 'bold', color: COLOR.ink } },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: COLOR.flat, width: 1, type: 'dashed' },
          data: [{ xAxis: 0 }, { yAxis: 0 }],
        },
      },
    ],
  });
}

/* ---------------- PMI ---------------- */

function renderPmi(d) {
  const list = d.pmi || [];
  if (!list.length) {
    emptyChart('chart-pmi', '所选区间内没有 PMI 数据');
    return;
  }

  const monthSet = {};
  list.forEach((p) => {
    (p.points || []).forEach((pt) => {
      monthSet[pt.month] = true;
    });
  });
  const months = Object.keys(monthSet).sort();
  if (!months.length) {
    emptyChart('chart-pmi', '所选区间内没有 PMI 数据');
    return;
  }

  // 图例的 selected 以 series.name 为键，所以这里用 shortLabel 而不是 id
  const selected = {};
  list.forEach((p, i) => {
    selected[p.shortLabel] = PMI_DEFAULT.indexOf(p.id) !== -1;
  });

  const series = list.map((p, i) => {
    const map = {};
    (p.points || []).forEach((pt) => {
      map[pt.month] = pt.value;
    });
    return {
      name: p.shortLabel,
      type: 'line',
      data: months.map((m) => (map[m] === undefined ? null : map[m])),
      connectNulls: false,
      showSymbol: false,
      lineStyle: { width: 1.6, color: PMI_COLORS[i % PMI_COLORS.length] },
      itemStyle: { color: PMI_COLORS[i % PMI_COLORS.length] },
      emphasis: { focus: 'series' },
    };
  });

  // 荣枯线挂到每条序列上（图例可以取消任意一条，挂单条会在取消后消失）；
  // 10 条重叠画出来仍是一条虚线，文字只留第一份，避免叠 10 遍
  series.forEach((s, i) => {
    s.markLine = {
      silent: true,
      symbol: 'none',
      lineStyle: { color: '#8b5cf6', width: 1, type: 'dashed' },
      label: i === 0
        ? { show: true, position: 'insideStartTop', formatter: '荣枯线 50', color: '#7c3aed', fontSize: 11 }
        : { show: false },
      data: [{ yAxis: 50 }],
    };
  });

  // y 轴按实际区间收缩（PMI 一般就在 45~56，固定 40~60 会把曲线挤在中间）
  let lo = 50;
  let hi = 50;
  list.forEach((p) => {
    (p.points || []).forEach((pt) => {
      if (pt.value === null || pt.value === undefined) return;
      if (pt.value < lo) lo = pt.value;
      if (pt.value > hi) hi = pt.value;
    });
  });
  const yMin = Math.max(30, Math.floor(lo - 1));
  const yMax = Math.min(70, Math.ceil(hi + 1));

  const interval = Math.max(0, Math.ceil(months.length / 12) - 1);

  applyOption('chart-pmi', {
    animation: false,
    grid: { left: 12, right: 30, top: 46, bottom: 16, containLabel: true },
    legend: {
      type: 'scroll',
      top: 4,
      left: 'center',
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: COLOR.ink2, fontSize: 11 },
      selected: selected,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(22, 24, 29, 0.92)',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: '#c9ced6' } },
      formatter: function (params) {
        if (!params.length) return '';
        const lines = [params[0].axisValue];
        params.forEach((p) => {
          if (p.value === null || p.value === undefined) return;
          lines.push(
            p.marker + p.seriesName + '　<b>' + Number(p.value).toFixed(1) + '</b>　' + (p.value >= 50 ? '扩张' : '收缩')
          );
        });
        return lines.join('<br/>');
      },
    },
    xAxis: Object.assign({}, axisStyle(), {
      type: 'category',
      boundaryGap: false,
      data: months,
      axisLabel: { color: COLOR.muted, fontSize: 11, interval: interval, formatter: (m) => m.slice(2) },
      splitLine: { show: false },
    }),
    yAxis: Object.assign({}, axisStyle(), {
      type: 'value',
      min: yMin,
      max: yMax,
      axisLabel: { color: COLOR.muted, fontSize: 11 },
    }),
    series: series,
  });
}

/* ---------------- 明细表 ---------------- */
function renderTable(d) {
  const rows = orderedIndustries(d);
  const month = latestOutputMonth(d);

  // 当期增加值排名（1 = 最高）
  const ranked = rows
    .filter((x) => month && x.output[month] !== undefined)
    .map((x) => ({ key: x.key, value: x.output[month] }))
    .sort((a, b) => b.value - a.value);
  const rankOf = {};
  ranked.forEach((x, i) => {
    rankOf[x.key] = i + 1;
  });

  const groups = (d.groups || []).filter((g) => g.key !== 'pmi');
  const html = [];
  groups.forEach((g) => {
    const members = rows.filter((x) => x.group === g.key);
    if (!members.length) return;
    html.push(
      '<tr class="group-row"><td colspan="5">' +
        escapeHtml(g.label) +
        '　' +
        members.length +
        ' 个大类行业</td></tr>'
    );
    members.forEach((x) => {
      const o = x.latest.output;
      const r = x.latest.revenue;
      const p = x.latest.profit;
      const rank = rankOf[x.key];
      html.push(
        '<tr>' +
          '<td title="' + escapeHtml(x.label) + '">' + escapeHtml(x.label) + '</td>' +
          '<td class="num" title="' + (o ? o.month : '') + '">' +
          (o ? span(o.value, fmt(o.value)) : '—') +
          '</td>' +
          '<td class="num" title="' + (r ? r.month : '') + '">' +
          (r ? span(r.value, fmt(r.value)) : '—') +
          '</td>' +
          '<td class="num" title="' + (p ? p.month : '') + '">' +
          (p ? span(p.value, fmt(p.value)) : '—') +
          '</td>' +
          '<td class="num">' + (rank ? rank : '—') + '</td>' +
          '</tr>'
      );
    });
  });

  el('detail-table').querySelector('tbody').innerHTML = html.join('');
  el('table-sub').innerHTML =
    '按行业分组排列；增加值取 ' +
    cnMonth(month) +
    '，营收与利润取各行业最新一期（表头悬停可看具体月份）；' +
    '「—」表示该期上游没有值，不插值、不补 0';
}

/* ---------------- 导出 ---------------- */

/**
 * 导出：最新一期快照 + 分行业月度序列 + PMI 分项，三块各自成段。
 * 增加值是当月同比（0 = 持平），营收与利润是累计同比，PMI 是扩散指数（50 = 荣枯线），三者不混算。
 */
function buildCsv() {
  const d = state.data;
  if (!d) {
    window.alert('数据还没加载完成，稍后再导出。');
    return;
  }
  const rows = orderedIndustries(d);
  const groupLabel = {};
  (d.groups || []).forEach((g) => {
    groupLabel[g.key] = g.label;
  });

  const month = latestOutputMonth(d);
  const ranked = rows
    .filter((x) => month && x.output[month] !== undefined)
    .map((x) => ({ key: x.key, value: x.output[month] }))
    .sort((a, b) => b.value - a.value);
  const rankOf = {};
  ranked.forEach((x, i) => {
    rankOf[x.key] = i + 1;
  });

  const snapCols = [
    { key: 'name', label: '行业' },
    { key: 'group', label: '分组' },
    { key: 'output', label: '工业增加值当月同比', unit: '%' },
    { key: 'outputMonth', label: '增加值月份' },
    { key: 'revenue', label: '营业收入累计同比', unit: '%' },
    { key: 'revenueMonth', label: '营收月份' },
    { key: 'profit', label: '利润总额累计同比', unit: '%' },
    { key: 'profitMonth', label: '利润月份' },
    { key: 'rank', label: '增加值排名', unit: '本期' },
  ];
  const snapRows = rows.map((x) => {
    const o = x.latest.output;
    const r = x.latest.revenue;
    const p = x.latest.profit;
    return {
      name: x.label,
      group: groupLabel[x.group] || x.group || '',
      output: o ? o.value : '',
      outputMonth: o ? o.month : '',
      revenue: r ? r.value : '',
      revenueMonth: r ? r.month : '',
      profit: p ? p.value : '',
      profitMonth: p ? p.month : '',
      rank: rankOf[x.key] || '',
    };
  });

  const monthSet = {};
  rows.forEach((x) => {
    ['output', 'revenue', 'profit'].forEach((k) => {
      Object.keys(x[k] || {}).forEach((m) => {
        monthSet[m] = true;
      });
    });
  });
  const months = Object.keys(monthSet).sort();
  const seriesCols = [
    { key: 'name', label: '行业' },
    { key: 'month', label: '月份' },
    { key: 'output', label: '工业增加值当月同比', unit: '%' },
    { key: 'revenue', label: '营业收入累计同比', unit: '%' },
    { key: 'profit', label: '利润总额累计同比', unit: '%' },
  ];
  const seriesRows = [];
  rows.forEach((x) => {
    months.forEach((m) => {
      const o = x.output[m];
      const r = x.revenue[m];
      const p = x.profit[m];
      if (o === undefined && r === undefined && p === undefined) return;
      seriesRows.push({
        name: x.label,
        month: m,
        output: o === undefined ? '' : o,
        revenue: r === undefined ? '' : r,
        profit: p === undefined ? '' : p,
      });
    });
  });

  const pmi = d.pmi || [];
  const pmSet = {};
  pmi.forEach((p) => {
    (p.points || []).forEach((pt) => {
      pmSet[pt.month] = true;
    });
  });
  const pmMonths = Object.keys(pmSet).sort();
  const pmiCols = [{ key: 'month', label: '月份' }].concat(
    pmi.map((p) => ({ key: p.id, label: p.shortLabel || p.label, unit: '扩散指数' }))
  );
  const pmiRows = pmMonths.map((m) => {
    const row = { month: m };
    pmi.forEach((p) => {
      const hit = (p.points || []).filter((pt) => pt.month === m)[0];
      row[p.id] = hit && hit.value !== null ? hit.value : '';
    });
    return row;
  });

  const blocks = [
    { title: '分行业最新一期（增加值取 ' + cnMonth(month) + '）', columns: snapCols, rows: snapRows },
    { title: '分行业月度序列', columns: seriesCols, rows: seriesRows },
    { title: 'PMI 分项', columns: pmiCols, rows: pmiRows },
  ].filter((b) => b.rows.length);

  if (!blocks.length) {
    window.alert('当前区间还没有数据可导出。');
    return;
  }

  Board.csv(
    {
      file: 'industry',
      fileSuffix: d.range ? d.range.from + '_' + d.range.to : months[0] + '_' + months[months.length - 1],
      module: '中国工业行业运行看板',
      source: '国家统计局 · 国家数据（月度库 · 工业 / 采购经理指数）',
      interface: '/api/industry',
      range: d.range ? d.range.from + ' ~ ' + d.range.to : months[0] + ' ~ ' + months[months.length - 1],
      note: [
        '工业增加值为当月同比（0 = 持平）；营业收入与利润总额为 1—N 月累计同比，本页不做单月差分',
        '1、2 月合并公布：增加值没有 1、2 月当月值，营收与利润 2 月值为 1—2 月累计',
        'PMI 是扩散指数，50 为荣枯线，与增速的 0 不是一个基准，不可同轴比较',
        '快照表里三个口径的月份可能不同（发布节奏不同），月份列已逐列标出',
        '规模以上工业指年主营业务收入 2000 万元及以上的工业企业，不是全部工业',
        '空单元格表示该期上游没有值，不插值、不补 0',
      ],
    },
    blocks
  );
}

/* ---------------- 状态与提示 ---------------- */

function renderStatus(d, err) {
  const node = el('status');
  node.className = 'status';

  if (err) {
    node.classList.add('is-error');
    node.textContent = err;
    return;
  }
  if (d.refreshing) {
    node.classList.add('is-warn');
    node.textContent = '正在后台核对新一期…';
    return;
  }
  if (d.stale) {
    node.classList.add('is-warn');
    node.textContent = '数据可能滞后';
    return;
  }
  node.classList.add('is-ok');
  node.textContent =
    '已对应发布期别' + (d.fetched ? '（本次补了 ' + d.fetched + ' 个栏目）' : '');
}

function renderHint(d) {
  const bits = [];
  if (d.range) {
    bits.push(
      '区间 ' + (d.range.from || '—') + ' ~ ' + (d.range.to || '—') + '（' + (d.range.label || '自定义') + '）'
    );
  }
  if (d.cache) {
    bits.push('缓存 ' + d.cache.series + ' 条序列 / ' + d.cache.points + ' 个数据点');
  }
  if (d.errors && d.errors.length) {
    bits.push('上游提示：' + d.errors[0]);
  }
  if (d.firstRun) {
    bits.push('首次打开已把 2018 年以来的历史一次拉全');
  } else if (d.generatedAt) {
    bits.push('数据生成于 ' + new Date(d.generatedAt).toLocaleString('zh-CN'));
  }
  el('range-hint').textContent = bits.join('　｜　');

  el('foot-meta').textContent =
    '数据生成时间 ' +
    (d.generatedAt ? new Date(d.generatedAt).toLocaleString('zh-CN') : '—') +
    '　请求耗时 ' +
    (d.elapsedMs || 0) +
    ' ms　缓存目录 .cache/industry/';
}

/* ---------------- 取数与轮询 ---------------- */

function stopPoll() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function schedulePoll() {
  stopPoll();
  if (state.polls >= 10) return;
  state.pollTimer = setTimeout(function () {
    state.polls += 1;
    load(false);
  }, 3000);
}

async function load(force) {
  if (state.loading) return;
  state.loading = true;
  stopPoll();

  const button = el('refresh');
  button.disabled = true;
  if (!state.data) {
    el('status').className = 'status';
    el('status').textContent = force ? '正在向统计局请求…' : '正在加载…';
  }

  try {
    const res = await fetch('/api/industry?' + queryString(force), { cache: 'no-store' });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('服务端返回的不是 JSON（HTTP ' + res.status + '）');
    }
    if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);

    state.data = data;
    if (force) state.polls = 0;
    renderAll(data);
    renderStatus(data, '');
    renderHint(data);

    if (data.refreshing || data.stale) schedulePoll();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (state.data) {
      renderStatus(state.data, '刷新失败：' + msg + '（仍在显示缓存）');
    } else {
      renderStatus(null, '加载失败：' + msg);
      el('range-hint').textContent = '请确认已通过 node server.js 启动本地服务，再访问 /industry/';
    }
  } finally {
    state.loading = false;
    button.disabled = false;
  }
}

function renderAll(d) {
  renderKpis(d);
  renderHeat(d);
  renderRank(d);
  renderQuad(d);
  renderPmi(d);
  renderTable(d);
}

/* ---------------- 交互 ---------------- */

function syncControls() {
  const select = el('range');
  const box = el('custom-box');
  select.value = state.range.mode;
  box.hidden = state.range.mode !== 'custom';

  const from = el('from');
  const to = el('to');
  const histFrom = (state.data && state.data.history && state.data.history.from) || '2018-01';
  from.min = histFrom;
  to.min = histFrom;
  if (state.range.from) from.value = state.range.from;
  if (state.range.to) to.value = state.range.to;
  // 端点提示：不超过服务端算出的应发布月份
  const horizon = (state.data && state.data.expectedLatest) || nowMonth();
  to.max = horizon;

  syncQuery();
}

/** 视图写回地址栏（不刷新、不新增历史）；自定义区间才会带 from/to */
function syncQuery() {
  const custom = state.range.mode === 'custom';
  Board.setQs({
    range: custom ? null : state.range.mode,
    from: custom ? state.range.from : null,
    to: custom ? state.range.to : null,
  });
}

function onRangeChange() {
  const mode = el('range').value;
  state.range.mode = mode;
  if (mode === 'custom') {
    const horizon = (state.data && state.data.expectedLatest) || nowMonth();
    const histFrom = (state.data && state.data.history && state.data.history.from) || '2018-01';
    if (!el('from').value) el('from').value = histFrom;
    if (!el('to').value) el('to').value = horizon;
    state.range.from = el('from').value;
    state.range.to = el('to').value;
  }
  saveRange();
  syncControls();

  if (mode !== 'custom' || (state.range.from && state.range.to)) {
    state.polls = 0;
    load(false);
  }
}

function onCustomChange() {
  state.range.from = el('from').value;
  state.range.to = el('to').value;
  if (!state.range.from || !state.range.to) return;
  if (state.range.from > state.range.to) {
    renderStatus(state.data, '起始月份不能晚于结束月份');
    return;
  }
  saveRange();
  state.polls = 0;
  load(false);
}

function init() {
  el('range').addEventListener('change', onRangeChange);
  el('from').addEventListener('change', onCustomChange);
  el('to').addEventListener('change', onCustomChange);
  Board.onExport(el('export-csv'), buildCsv);
  el('refresh').addEventListener('click', function () {
    state.polls = 0;
    load(true);
  });

  window.addEventListener('resize', function () {
    Object.keys(state.charts).forEach((k) => state.charts[k].resize());
  });

  syncControls();
  load(false);
}

document.addEventListener('DOMContentLoaded', init);
