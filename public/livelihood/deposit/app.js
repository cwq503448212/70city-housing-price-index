'use strict';

/**
 * 中国居民存款与人均存款看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/livelihood/reserve-deposit?range=...
 * 顶部时间选择一变，整页（KPI + 5 张图 + 明细表）全部按新区间重画。
 *
 * 口径铁律（与页脚一致，改前端别改口径）：
 *   - 余额、活期、定期是央行表里的官方原值；
 *   - 当月新增、累计新增、同比、人均都是服务端用余额/人口现算的值，图上标「计算值」；
 *   - 人均只有每年 12 月有值，横轴就是年份，不做月度插值；
 *   - 缺失就是缺失，画成空点，不补 0。
 */

(function () {
  // 这 4 个指标进 KPI，其余指标在明细表与图中出现
  const KPI_LIST = [
    { id: 'balance', deltaLabel: '较上月' },
    { id: 'monthly_add', deltaLabel: '较上月' },
    { id: 'ytd_add', deltaLabel: '较上月' },
    { id: 'per_capita', deltaLabel: '较上年' },
  ];

  const COLOR = {
    ink: '#16181d',
    muted: '#7b8391',
    line: '#e8eaee',
    lineStrong: '#d9dce2',
    accent: '#175cd3',
    accentLight: '#5b8def',
    teal: '#0e7490',
    up: '#d14343',
    down: '#1f9254',
    flat: '#98a1ae',
  };

  // 用户可选的时间范围存本地：改默认值时必须同时升级这个键名（v1 -> v2）
  const RANGE_KEY = 'livelihood.deposit.range.v1';
  const DEFAULT_RANGE = '5';

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
    table: $('detail-table').querySelector('tbody'),
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
      localStorage.setItem(
        RANGE_KEY,
        JSON.stringify({ range: state.range, from: state.from, to: state.to })
      );
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

  function isGrowth(ind) {
    return ind.kind === 'growth';
  }

  /** 千分位 + 固定小数位；缺失值统一显示破折号 */
  function fmtNum(v, decimals) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const d = typeof decimals === 'number' ? decimals : 2;
    const parts = v.toFixed(d).split('.');
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

  function fmtValue(ind, v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return isGrowth(ind) ? fmtNum(v, ind.decimals) + '%' : fmtNum(v, ind.decimals) + ' ' + ind.unit;
  }

  function fmtDelta(ind, d) {
    if (d === null || d === undefined || !isFinite(d)) return '—';
    const unit = isGrowth(ind) ? ' 个百分点' : ' ' + ind.unit;
    return fmtSigned(d, isGrowth(ind) ? 1 : ind.decimals) + unit;
  }

  /** 上游错误信息会进 title 属性，做一次转义避免引号截断 */
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

  function yearCn(y) {
    return y ? y + ' 年' : '—';
  }

  /* ---------------- 数据访问 ---------------- */

  function byId(id) {
    if (!state.data) return null;
    return state.data.indicators.filter((x) => x.id === id)[0] || null;
  }

  function seriesOf(id) {
    const ind = byId(id);
    if (!ind) return [];
    return ind.points.map((p) => (p.value === null ? null : p.value));
  }

  function monthsOf() {
    const ind = state.data && state.data.indicators[0];
    return ind ? ind.points.map((p) => p.month) : [];
  }

  function pointAt(id, month) {
    const ind = byId(id);
    if (!ind) return null;
    const hit = ind.points.filter((p) => p.month === month)[0];
    return hit && hit.value !== null ? hit.value : null;
  }

  /** 该指标在所选区间内最后一个有数据的点 */
  function lastPoint(ind) {
    if (!ind) return null;
    const hit = ind.points.filter((p) => p.value !== null);
    return hit.length ? hit[hit.length - 1] : null;
  }

  /** 上一个有数据的点（可能不是紧邻月份，月份会一并显示） */
  function prevPoint(ind, last) {
    if (!ind || !last) return null;
    const hit = ind.points.filter((p) => p.value !== null && p.month < last.month);
    return hit.length ? hit[hit.length - 1] : null;
  }

  /* ---------------- 图表基座 ---------------- */

  function chartOf(id) {
    const dom = document.getElementById(id);
    if (!dom) return null;
    if (!state.charts[id]) state.charts[id] = echarts.init(dom, null, { renderer: 'canvas' });
    return state.charts[id];
  }

  function baseOption() {
    return {
      animationDuration: 420,
      grid: { left: 46, right: 20, top: 34, bottom: 30, containLabel: true },
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
        itemWidth: 8,
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
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: COLOR.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: COLOR.line } },
        scale: true,
      },
    };
  }

  function lineSeries(name, values, color, extra) {
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

  function emptyChart(id, text) {
    const chart = chartOf(id);
    if (!chart) return;
    chart.clear();
    chart.setOption({
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: 'middle',
          style: { text: text, fill: COLOR.muted, fontSize: 13 },
        },
      ],
    });
  }

  /** 折线 / 柱状图的 tooltip：统一按单位拼行 */
  function axisTooltip(months, unit, decimals) {
    return (params) => {
      const head = monthCn(months[params[0].dataIndex]);
      const rows = params
        .map((p) => {
          const v = p.value === null || p.value === undefined ? '—' : fmtNum(p.value, decimals) + unit;
          return p.marker + ' ' + p.seriesName + '　' + v;
        })
        .join('<br/>');
      return head + '<br/>' + rows;
    };
  }

  /* ---------------- 各图 ---------------- */

  function renderBalance() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-balance', '暂无数据');
    const option = baseOption();
    option.xAxis.data = months;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 0);
    option.tooltip.formatter = axisTooltip(months, ' 万亿元', 2);
    option.series = [
      lineSeries('住户存款余额', seriesOf('balance'), COLOR.accent, {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(23,92,211,0.18)' },
              { offset: 1, color: 'rgba(23,92,211,0.01)' },
            ],
          },
        },
      }),
    ];
    chartOf('chart-balance').setOption(option, true);
  }

  function renderAdd() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-add', '暂无数据');
    const values = seriesOf('monthly_add');
    const option = baseOption();
    option.xAxis.data = months;
    option.xAxis.boundaryGap = true;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 0);
    option.tooltip.formatter = axisTooltip(months, ' 亿元', 0);
    option.series = [
      {
        name: '当月新增',
        type: 'bar',
        barMaxWidth: 14,
        data: values.map((v) => ({
          value: v,
          // 红涨绿跌：住户存款减少的月份用绿色，避免看错方向
          itemStyle: { color: v === null ? COLOR.flat : v < 0 ? COLOR.down : COLOR.up, borderRadius: 2 },
        })),
        markLine: {
          silent: true,
          symbol: 'none',
          label: { formatter: '0', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
          lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
    ];
    chartOf('chart-add').setOption(option, true);
  }

  function renderStructure() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-structure', '暂无数据');
    const option = baseOption();
    option.xAxis.data = months;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 0);
    option.tooltip.formatter = axisTooltip(months, ' 万亿元', 2);
    const demand = lineSeries('活期存款', seriesOf('demand'), COLOR.accentLight, {
      stack: 'deposit',
      areaStyle: { color: 'rgba(91,141,239,0.35)' },
    });
    const time = lineSeries('定期及其他', seriesOf('time_deposit'), COLOR.accent, {
      stack: 'deposit',
      areaStyle: { color: 'rgba(23,92,211,0.55)' },
    });
    option.series = [demand, time];
    chartOf('chart-structure').setOption(option, true);
  }

  function renderYoy() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-yoy', '暂无数据');
    const option = baseOption();
    option.xAxis.data = months;
    option.yAxis.axisLabel.formatter = '{value}%';
    option.tooltip.formatter = axisTooltip(months, '%', 1);
    option.series = [
      lineSeries('余额同比', seriesOf('yoy'), COLOR.teal, {
        markLine: {
          silent: true,
          symbol: 'none',
          label: { formatter: '0%', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
          lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      }),
    ];
    chartOf('chart-yoy').setOption(option, true);
  }

  /** 人均只有每年 12 月有值：横轴换成「年份」，避免 12 个空格子撑出一条断线 */
  function perCapitaPoints() {
    const ind = byId('per_capita');
    if (!ind) return [];
    return ind.points.filter((p) => p.value !== null);
  }

  function renderPerCapita() {
    const rows = perCapitaPoints();
    if (!rows.length) return emptyChart('chart-percapita', '暂无人均数据（需要年末人口与 12 月余额）');
    const years = rows.map((p) => p.month.slice(0, 4));
    const values = rows.map((p) => p.value);
    const option = baseOption();
    option.xAxis.data = years;
    option.xAxis.axisLabel.formatter = (v) => v;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 1);
    option.tooltip.formatter = (params) => {
      const p = params[0];
      return yearCn(years[p.dataIndex]) + ' 末<br/>' + p.marker + ' 人均存款　' + fmtNum(p.value, 2) + ' 万元';
    };
    option.series = [
      lineSeries('人均存款', values, COLOR.accent, {
        showSymbol: true,
        symbolSize: 7,
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(23,92,211,0.14)' },
              { offset: 1, color: 'rgba(23,92,211,0.01)' },
            ],
          },
        },
        label: {
          show: true,
          position: 'top',
          distance: 6,
          color: COLOR.muted,
          fontSize: 11,
          formatter: (p) => fmtNum(p.value, 2),
        },
      }),
    ];
    chartOf('chart-percapita').setOption(option, true);
  }

  /* ---------------- KPI 与表格 ---------------- */

  function renderKpi() {
    el.kpiRow.innerHTML = '';
    KPI_LIST.forEach((cfg) => {
      const ind = byId(cfg.id);
      const card = document.createElement('div');
      card.className = 'kpi';

      if (!ind) {
        card.innerHTML = '<div class="kpi-label">' + cfg.label + '</div><div class="kpi-value">—</div>';
        el.kpiRow.appendChild(card);
        return;
      }

      const latest = lastPoint(ind);
      let base = prevPoint(ind, latest);
      let deltaLabel = cfg.deltaLabel;

      // 累计新增看「比上年同期推进得多快」比看月度环比更有意义
      if (cfg.id === 'ytd_add' && latest) {
        const same = String(Number(latest.month.slice(0, 4)) - 1) + '-' + latest.month.slice(5, 7);
        const hit = ind.points.filter((p) => p.month === same && p.value !== null)[0];
        if (hit) {
          base = hit;
          deltaLabel = '较上年同期';
        }
      }

      let deltaHtml = '<span class="kpi-delta flat">—</span>';
      if (latest && base) {
        const d = Math.round((latest.value - base.value) * 100) / 100;
        deltaHtml =
          '<span class="kpi-delta ' + signClass(d) + '">' + deltaLabel + ' ' + fmtDelta(ind, d) + '</span>';
      }

      const valueText = latest
        ? isGrowth(ind)
          ? fmtSigned(latest.value, ind.decimals) + '<small>%</small>'
          : fmtNum(latest.value, ind.decimals) + '<small>' + ind.unit + '</small>'
        : '—';

      const tags =
        (ind.computed ? ' <span class="tag">计算值</span>' : '') +
        (ind.stale ? ' <span class="tag warn">待更新</span>' : '');

      card.innerHTML =
        '<div class="kpi-label">' +
        esc(ind.label) +
        tags +
        '</div>' +
        '<div class="kpi-value ' +
        (isGrowth(ind) ? signClass(latest ? latest.value : null) : '') +
        '">' +
        valueText +
        '</div>' +
        '<div class="kpi-foot"><span>' +
        monthCn(latest ? latest.month : '') +
        '</span>' +
        deltaHtml +
        '</div>';

      el.kpiRow.appendChild(card);
    });
  }

  /** 按年分组、年份倒序、同一年内月份升序 */
  function groupedMonths() {
    const months = monthsOf();
    const map = new Map();
    months.forEach((m) => {
      const y = m.slice(0, 4);
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(m);
    });
    return Array.from(map.keys())
      .sort()
      .reverse()
      .map((y) => ({ year: y, months: map.get(y) }));
  }

  function renderTable() {
    if (!state.data) return;
    el.table.innerHTML = '';
    const ind = {
      balance: byId('balance'),
      monthly_add: byId('monthly_add'),
      ytd_add: byId('ytd_add'),
      yoy: byId('yoy'),
      demand: byId('demand'),
      time_deposit: byId('time_deposit'),
      per_capita: byId('per_capita'),
    };

    groupedMonths().forEach((group) => {
      const lastMonth = group.months[group.months.length - 1];
      const ytd = pointAt('ytd_add', lastMonth);

      const head = document.createElement('tr');
      head.className = 'group-row';
      head.innerHTML =
        '<td colspan="8">' +
        esc(group.year) +
        ' 年　·　' +
        group.months.length +
        ' 个月' +
        (ytd === null ? '' : '　·　年初至今累计新增 ' + fmtNum(ytd, 0) + ' 亿元') +
        '</td>';
      el.table.appendChild(head);

      group.months.forEach((month) => {
        const cells = [
          { v: monthCn(month), cls: '' },
          { v: fmtNum(pointAt('balance', month), 2), cls: '' },
          { v: fmtNum(pointAt('monthly_add', month), 0), cls: signClass(pointAt('monthly_add', month)) },
          { v: fmtNum(pointAt('ytd_add', month), 0), cls: signClass(pointAt('ytd_add', month)) },
          { v: fmtNum(pointAt('yoy', month), 1), cls: signClass(pointAt('yoy', month)) },
          { v: fmtNum(pointAt('demand', month), 2), cls: '' },
          { v: fmtNum(pointAt('time_deposit', month), 2), cls: '' },
          { v: fmtNum(pointAt('per_capita', month), 2), cls: '' },
        ];
        const tr = document.createElement('tr');
        tr.innerHTML = cells
          .map((c, i) => {
            const num = i === 0 ? '' : ' num';
            return '<td class="' + c.cls + num + '">' + esc(c.v) + '</td>';
          })
          .join('');
        el.table.appendChild(tr);
      });
    });

    // 指标声明里有 unit 但表格表头已带单位：这里只在单位异常时兜个底
    if (!ind.balance) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="8">暂无数据</td>';
      el.table.appendChild(tr);
    }
  }

  /* ---------------- 导出 ---------------- */

  /**
   * 导出：当前月份区间内的月度长表，一行一个月。
   * 余额/活期/定期是官方原值，当月新增/累计新增/同比/人均是本页计算，导出时一并标清。
   */
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
    const columns = [
      { key: 'month', label: '月份' },
      { key: 'balance', label: '住户存款余额', unit: '万亿元' },
      { key: 'monthly_add', label: '当月新增', unit: '亿元', calc: true },
      { key: 'ytd_add', label: '累计新增', unit: '亿元', calc: true },
      { key: 'yoy', label: '余额同比', unit: '%', calc: true },
      { key: 'demand', label: '活期存款', unit: '万亿元' },
      { key: 'time_deposit', label: '定期及其他存款', unit: '万亿元' },
      { key: 'per_capita', label: '人均存款', unit: '万元/人', calc: true },
    ];
    const cell = (id, m) => {
      const v = pointAt(id, m);
      return v === null ? '' : v;
    };
    const rows = months.map((m) => ({
      month: m,
      balance: cell('balance', m),
      monthly_add: cell('monthly_add', m),
      ytd_add: cell('ytd_add', m),
      yoy: cell('yoy', m),
      demand: cell('demand', m),
      time_deposit: cell('time_deposit', m),
      per_capita: cell('per_capita', m),
    }));

    Board.csv(
      {
        file: 'livelihood-deposit',
        fileSuffix: months[0] + '_' + months[months.length - 1],
        module: '中国居民存款与人均存款看板',
        source: '中国人民银行 · 调查统计司（金融机构人民币信贷收支表）；人均分母为国家统计局年末总人口',
        interface: '/api/livelihood/reserve-deposit',
        range: months[0] + ' ~ ' + months[months.length - 1] + '，共 ' + months.length + ' 个月',
        note: [
          '余额 / 活期 / 定期及其他为央行「住户存款」行原值，原始单位亿元，本页除以 10000 折算为万亿元',
          '央行只发布「年初至今累计增量」，当月新增与累计新增由余额差分得出，属本页计算值',
          '同比 = 本月余额 ÷ 上年同月余额 − 1；人均 = 当年 12 月余额 ÷ 年末总人口，只在 12 月有值',
          '活期 + 定期及其他 = 住户存款；空单元格表示官方未发布或该月无值，不插值、不补 0',
        ],
      },
      [{ title: '月度明细', columns: columns, rows: rows }]
    );
  }

  Board.onExport(el.exportBtn, buildCsv);

  /* ---------------- 状态栏 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.title = text;
  }

  // 首次运行要拉 12 个年份（约四十个请求）：超过 3 秒还没回来就换一句提示，避免用户以为卡住
  let slowHintTimer = null;

  function hintSlow() {
    clearTimeout(slowHintTimer);
    if (state.data) return;
    slowHintTimer = setTimeout(function () {
      setStatus('首次运行或缓存落后，正在向央行补齐数据，约需半分钟到一分钟…');
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
          (json.fetched ? '　本次回源 ' + json.fetched + ' 个年份' : '　全部命中本地缓存') +
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
      '（央行每月 10–15 日发布上月数据）';

    el.footMeta.textContent =
      '生成时间 ' +
      new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false }) +
      '　耗时 ' +
      d.elapsedMs +
      ' ms　本次回源 ' +
      d.fetched +
      ' 个年份　缓存目录 ' +
      d.cache.dir +
      '（' +
      d.cache.years +
      ' 个年度文件 / ' +
      d.cache.months +
      ' 个月，人口 ' +
      d.cache.populationYears +
      ' 个年份）';
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

  const API = '/api/livelihood/reserve-deposit';

  const CHART_IDS = ['chart-balance', 'chart-add', 'chart-structure', 'chart-yoy', 'chart-percapita'];

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    clearTimeout(pollTimer);
    pollCount = 0;
    setStatus(force ? '正在重新向央行请求…' : '正在读取数据…');
    hintSlow();

    try {
      const res = await fetch(API + '?' + queryString(force), { headers: { Accept: 'application/json' } });
      const json = await res.json();
      if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);

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
    renderBalance();
    renderAdd();
    renderStructure();
    renderYoy();
    renderPerCapita();
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
    el.range.innerHTML = '';
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

  // 服务端对「有缓存但可能滞后」的年份不阻塞首屏（先用缓存出图、后台回源），
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
      const res = await fetch(API + '?' + queryString(false), { headers: { Accept: 'application/json' } });
      const json = await res.json();
      if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);
      buildRangeSelect(json.presets);
      syncQuery();
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
    } finally {
      clearHint();
    }
  })();
})();
