'use strict';

/**
 * 中国社会消费品零售看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/livelihood/retail?range=...
 * 顶部时间选择一变，整页（KPI + 8 张图 + 明细表）全部按新区间重画。
 *
 * 口径铁律（与页脚一致，改前端别改口径）：
 *   - 当月值 / 累计值 / 同比 / 各类值都是统计局发布的官方原值；
 *   - 剔除汽车、剔除汽车同比、乡村占比、网上占比是服务端现算的值，图上标「计算值」；
 *   - 1、2 月合并公布：当月值没有 1 月与 2 月，累计值从 2 月（1—2 月合计）开始；
 *   - 网上零售 2026 年起换口径，新旧两段画两条线，不拼接；
 *   - 缺失就是缺失，画成空点，不补 0。
 */

(function () {
  // 5 个 KPI：主指标 + 副指标（deltaId 取同月值）
  const KPI_LIST = [
    { id: 'total_amount', deltaId: 'total_yoy', deltaLabel: '当月同比', mode: 'growth' },
    { id: 'total_cum', deltaId: 'total_cum_yoy', deltaLabel: '累计同比', mode: 'growth' },
    { id: 'catering_amount', deltaId: 'catering_yoy', deltaLabel: '当月同比', mode: 'growth' },
    { id: 'online_goods_cum', altId: 'online_goods_cum_new', deltaId: 'online_share', deltaLabel: '占社零', mode: 'level' },
    { id: 'ex_car_amount', deltaId: 'ex_car_yoy', deltaLabel: '同比（计算）', mode: 'growth' },
  ];

  // 明细表列（顺序必须与 index.html 的 thead 一致）
  const COLUMNS = [
    { id: 'total_amount', sign: false },
    { id: 'total_yoy', sign: true },
    { id: 'total_cum', sign: false },
    { id: 'total_cum_yoy', sign: true },
    { id: 'catering_amount', sign: false },
    { id: 'goods_amount', sign: false },
    { id: 'urban_amount', sign: false },
    { id: 'rural_amount', sign: false },
    { id: 'online_goods_cum', sign: false },
    { id: 'online_goods_cum_new', sign: false },
    { id: 'online_share', sign: false },
    { id: 'grain_amount', sign: false },
    { id: 'appliance_amount', sign: false },
    { id: 'car_amount', sign: false },
    { id: 'ex_car_amount', sign: false },
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
  const RANGE_KEY = 'livelihood.retail.range.v1';
  const DEFAULT_RANGE = '5';
  const API = '/api/livelihood/retail';

  const CHART_IDS = [
    'chart-total',
    'chart-cum',
    'chart-type',
    'chart-place',
    'chart-online',
    'chart-category',
    'chart-category-yoy',
    'chart-excar',
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
    table: $('detail-table').querySelector('tbody'),
    tableHead: $('detail-table').querySelector('thead tr'),
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

  function isGrowth(ind) {
    return ind.kind === 'growth';
  }

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

  /* ---------------- 数据访问 ---------------- */

  function byId(id) {
    if (!state.data) return null;
    return state.data.indicators.filter((x) => x.id === id)[0] || null;
  }

  function monthsOf() {
    const ind = state.data && state.data.indicators[0];
    return ind ? ind.points.map((p) => p.month) : [];
  }

  function pointsOf(id) {
    const ind = byId(id);
    return ind ? ind.points : [];
  }

  /** 与 monthsOf() 对齐的一维数组 */
  function seriesOf(id) {
    const map = new Map(pointsOf(id).map((p) => [p.month, p.value]));
    return monthsOf().map((m) => (map.has(m) ? map.get(m) : null));
  }

  function pointAt(id, month) {
    const hit = pointsOf(id).filter((p) => p.month === month)[0];
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
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: formatter || ((v) => fmtNum(v, 0)) },
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
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: formatter || ((v) => v + '%') },
      splitLine: { show: false },
    };
  }

  function baseOption(dual) {
    const option = {
      animationDuration: 420,
      grid: { left: 8, right: dual ? 8 : 8, top: 40, bottom: 26, containLabel: true },
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
        boundaryGap: false,
        axisLine: { lineStyle: { color: COLOR.lineStrong } },
        axisTick: { show: false },
        axisLabel: {
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

  /** tooltip：按 seriesIndex 取单位后缀，统一 1 位小数 */
  function makeTooltip(months, suffixes) {
    return (params) => {
      if (!params || !params.length) return '';
      const head = monthCn(months[params[0].dataIndex]);
      const rows = params.map((p) => {
        const suffix = suffixes[p.seriesIndex] || '';
        const v = p.value === null || p.value === undefined ? '—' : fmtNum(p.value, 1) + suffix;
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
        barMaxWidth: 12,
        itemStyle: { color: color, borderRadius: [2, 2, 0, 0] },
        emphasis: { focus: 'series' },
      },
      extra || {}
    );
  }

  function dashed(name, values, color, extra) {
    return line(name, values, color, Object.assign({ yAxisIndex: 1, lineStyle: { width: 1.6, color: color, type: 'dashed' } }, extra || {}));
  }

  function zeroLine(label) {
    return {
      silent: true,
      symbol: 'none',
      label: { formatter: label || '0', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
      lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
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

  /* ---------------- 各图 ---------------- */

  function renderTotal() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-total', '暂无数据');
    const option = baseOption(true);
    option.xAxis.data = months;
    option.xAxis.boundaryGap = true;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => v + '%');
    option.tooltip.formatter = makeTooltip(months, [' 亿元', '%']);
    option.series = [
      bar('社零总额当月', seriesOf('total_amount'), COLOR.accent),
      dashed('当月同比', seriesOf('total_yoy'), COLOR.teal),
    ];
    apply('chart-total', option);
  }

  function renderCum() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-cum', '暂无数据');
    const option = baseOption(true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), true);
    option.yAxis[1] = rightAxis((v) => v + '%');
    option.tooltip.formatter = makeTooltip(months, [' 亿元', '%']);
    option.series = [
      line('社零累计', seriesOf('total_cum'), COLOR.accent, {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(23,92,211,0.16)' },
              { offset: 1, color: 'rgba(23,92,211,0.01)' },
            ],
          },
        },
      }),
      dashed('累计同比', seriesOf('total_cum_yoy'), COLOR.teal),
    ];
    apply('chart-cum', option);
  }

  function renderType() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-type', '暂无数据');
    const option = baseOption(true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), true);
    option.yAxis[1] = rightAxis((v) => v + '%');
    option.tooltip.formatter = makeTooltip(months, [' 亿元', ' 亿元', '%', '%']);
    option.series = [
      line('商品零售', seriesOf('goods_amount'), COLOR.accent),
      line('餐饮收入', seriesOf('catering_amount'), COLOR.amber),
      dashed('商品零售同比', seriesOf('goods_yoy'), COLOR.accentLight),
      dashed('餐饮同比', seriesOf('catering_yoy'), COLOR.amberLight),
    ];
    apply('chart-type', option);
  }

  function renderPlace() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-place', '暂无数据');
    const option = baseOption(true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), true);
    option.yAxis[1] = rightAxis((v) => v + '%');
    option.tooltip.formatter = makeTooltip(months, [' 亿元', ' 亿元', '%']);
    option.series = [
      line('城镇', seriesOf('urban_amount'), COLOR.accent),
      line('乡村', seriesOf('rural_amount'), COLOR.teal),
      dashed('乡村占比（计算）', seriesOf('rural_share'), COLOR.violet),
    ];
    apply('chart-place', option);
  }

  function renderOnline() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-online', '暂无数据');
    const option = baseOption(true);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), true);
    option.yAxis[1] = rightAxis((v) => v + '%');
    option.tooltip.formatter = makeTooltip(months, [' 亿元', ' 亿元', '%']);
    option.series = [
      line('实物商品网上零售（旧口径，累计）', seriesOf('online_goods_cum'), COLOR.accent),
      line('网上商品零售（新口径，累计）', seriesOf('online_goods_cum_new'), COLOR.violet, {
        markLine: {
          silent: true,
          symbol: 'none',
          label: { formatter: '2026 起换口径', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
          lineStyle: { color: COLOR.flat, type: 'dashed', width: 1 },
          data: [{ xAxis: '2026-02' }],
        },
      }),
      dashed('占社零比重（计算）', seriesOf('online_share'), COLOR.amber),
    ];
    apply('chart-online', option);
  }

  function renderCategory() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-category', '暂无数据');
    const option = baseOption(false);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), true);
    option.tooltip.formatter = makeTooltip(months, [' 亿元', ' 亿元', ' 亿元']);
    option.series = [
      line('粮油食品类', seriesOf('grain_amount'), COLOR.amber),
      line('家用电器和音像器材类', seriesOf('appliance_amount'), COLOR.teal),
      line('汽车类', seriesOf('car_amount'), COLOR.violet),
    ];
    apply('chart-category', option);
  }

  function renderCategoryYoy() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-category-yoy', '暂无数据');
    const option = baseOption(false);
    option.xAxis.data = months;
    option.yAxis[0] = leftAxis((v) => v + '%', true);
    option.tooltip.formatter = makeTooltip(months, ['%', '%', '%']);
    option.series = [
      line('粮油食品类同比', seriesOf('grain_yoy'), COLOR.amber, { markLine: zeroLine() }),
      line('家用电器和音像器材类同比', seriesOf('appliance_yoy'), COLOR.teal),
      line('汽车类同比', seriesOf('car_yoy'), COLOR.violet),
    ];
    apply('chart-category-yoy', option);
  }

  function renderExCar() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-excar', '暂无数据');
    const option = baseOption(true);
    option.xAxis.data = months;
    option.xAxis.boundaryGap = true;
    option.yAxis[0] = leftAxis((v) => fmtNum(v, 0), false);
    option.yAxis[1] = rightAxis((v) => v + '%');
    option.tooltip.formatter = makeTooltip(months, [' 亿元', '%']);
    option.series = [
      bar('剔除汽车后社零（计算）', seriesOf('ex_car_amount'), COLOR.accent),
      dashed('剔除汽车同比（计算）', seriesOf('ex_car_yoy'), COLOR.teal),
    ];
    apply('chart-excar', option);
  }

  /* ---------------- KPI ---------------- */

  /** 两个指标里取「最新点更晚」的那个（网上零售旧口径 / 新口径） */
  function pickLatest(ids) {
    let best = null;
    ids.forEach((id) => {
      const ind = byId(id);
      const point = lastPoint(ind);
      if (!point) return;
      if (!best || point.month > best.point.month) best = { ind: ind, point: point };
    });
    return best;
  }

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
      const picked = cfg.altId ? pickLatest([cfg.id, cfg.altId]) : pickLatest([cfg.id]);

      if (!picked) {
        label.textContent = cfg.id;
        card.appendChild(label);
        card.appendChild(node('div', 'kpi-value', '—'));
        el.kpiRow.appendChild(card);
        return;
      }

      const ind = picked.ind;
      const latest = picked.point;

      label.appendChild(document.createTextNode(ind.label));
      if (ind.computed) label.appendChild(node('span', 'tag', '计算值'));
      if (ind.archived) label.appendChild(node('span', 'tag info', '旧口径'));
      if (ind.stale) label.appendChild(node('span', 'tag warn', '待更新'));
      card.appendChild(label);

      const value = node('div', 'kpi-value' + (isGrowth(ind) ? ' ' + signClass(latest.value) : ''));
      value.appendChild(
        document.createTextNode(
          isGrowth(ind) ? fmtSigned(latest.value, ind.decimals) : fmtNum(latest.value, ind.decimals)
        )
      );
      value.appendChild(node('small', '', isGrowth(ind) ? '%' : ind.unit));
      card.appendChild(value);

      const foot = node('div', 'kpi-foot');
      foot.appendChild(node('span', '', monthCn(latest.month)));

      const deltaValue = cfg.deltaId ? pointAt(cfg.deltaId, latest.month) : null;
      if (deltaValue === null) {
        foot.appendChild(node('span', 'kpi-delta flat', '—'));
      } else {
        const sign = cfg.mode === 'growth' ? signClass(deltaValue) : 'flat';
        const body = cfg.mode === 'growth' ? fmtSigned(deltaValue, 1) + '%' : fmtNum(deltaValue, 1) + '%';
        foot.appendChild(node('span', 'kpi-delta ' + sign, cfg.deltaLabel + ' ' + body));
      }
      card.appendChild(foot);

      el.kpiRow.appendChild(card);
    });
  }

  /* ---------------- 明细表 ---------------- */

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

  function cell(text, cls) {
    return node('td', cls, text);
  }

  function renderTable() {
    if (!state.data) return;
    el.table.replaceChildren();
    const cols = COLUMNS.length + 1;

    groupedMonths().forEach((group) => {
      const lastMonth = group.months[group.months.length - 1];
      const cum = pointAt('total_cum', lastMonth);
      const cumYoy = pointAt('total_cum_yoy', lastMonth);

      const head = document.createElement('tr');
      head.className = 'group-row';
      const headCell = cell(
        group.year +
          ' 年　·　' +
          group.months.length +
          ' 个月' +
          (cum === null ? '' : '　·　当年累计社零 ' + fmtNum(cum, 1) + ' 亿元') +
          (cumYoy === null ? '' : '（累计同比 ' + fmtSigned(cumYoy, 1) + '%）')
      );
      headCell.colSpan = cols;
      head.appendChild(headCell);
      el.table.appendChild(head);

      group.months.forEach((month) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(monthCn(month)));
        COLUMNS.forEach((col) => {
          const v = pointAt(col.id, month);
          tr.appendChild(cell(fmtNum(v, 1), 'num' + (col.sign ? ' ' + signClass(v) : '')));
        });
        el.table.appendChild(tr);
      });
    });

    if (!el.table.children.length) {
      const tr = document.createElement('tr');
      const td = cell('暂无数据');
      td.colSpan = cols;
      tr.appendChild(td);
      el.table.appendChild(tr);
    }
  }

  /* ---------------- 状态栏 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.title = text;
  }

  // 首次运行要拉 8 个栏目：超过 3 秒还没回来就换一句提示，避免用户以为卡住
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

  /** 状态栏只看服务端给的 stale / errors / expectedLatest，不自己猜月份 */
  function applyStatus(json) {
    const staleList = json.indicators.filter((x) => x.stale);
    const busy = json.refreshing ? '（后台补齐中…）' : '';

    if (json.errors && json.errors.length) {
      setStatus(
        '上游异常，' + staleList.length + ' 个指标已回退缓存（最新 ' + (json.latestMonth || '—') + '）' + busy,
        'warn'
      );
      el.status.title = json.errors.join('\n');
      return;
    }
    if (!staleList.length) {
      const first = json.firstRun ? '　首次运行已把全部历史写入缓存' : '';
      setStatus(
        '数据完整　最新 ' +
          (json.latestMonth || '—') +
          '（应发布 ' +
          (json.expectedLatest || '—') +
          '）' +
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
        '（最新 ' +
        (json.latestMonth || '—') +
        '，应发布 ' +
        (json.expectedLatest || '—') +
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
      '　共 ' +
      count +
      ' 个月；最新已入库 ' +
      (d.latestMonth || '—') +
      '，应发布到 ' +
      (d.expectedLatest || '—') +
      '（统计局每月 15 日左右发布上月数据，1、2 月合并公布）';

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
      d.cache.points +
      ' 个数据点，最新 ' +
      (d.cache.latest || '—') +
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
    renderTotal();
    renderCum();
    renderType();
    renderPlace();
    renderOnline();
    renderCategory();
    renderCategoryYoy();
    renderExCar();
    renderTable();
    renderMeta();
  }

  /* ---------------- 交互 ---------------- */

  function syncInputs(json) {
    if (!json || !json.history) return;
    el.from.min = json.history.from;
    el.to.max = json.expectedLatest;
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
        el.from.min = json.history.from;
        el.to.max = json.expectedLatest;
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
