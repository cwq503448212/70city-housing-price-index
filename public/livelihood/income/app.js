'use strict';

/**
 * 中国居民人均收入与支出看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/livelihood/income-expenditure?range=...
 * 顶部时间选择一变，整页（KPI + 6 张图 + 明细表）全部按新区间重画。
 * 前端不判断「哪一年该有数」——那是服务端 lib/livelihood/policy.js 的事，这里只消费 stale 字段。
 *
 * 口径铁律：
 *   - 增速只有官方发布的「比上年增长」（名义增速），不自行用 CPI 折算实际增速；
 *   - 四项收入 / 八项消费都是官方直接发布值，不做加权合成；
 *   - 城乡是分户口径，不做算术平均。
 */

(function () {
  // 只有这 4 个指标进 KPI，其余指标在明细表与图中出现
  const KPI_LIST = [
    { id: 'income_value', label: '人均可支配收入' },
    { id: 'income_yoy', label: '收入名义增速' },
    { id: 'spend_value', label: '人均消费支出' },
    { id: 'spend_yoy', label: '支出名义增速' },
  ];

  const INCOME_PARTS = [
    { id: 'income_wage', name: '工资性收入', color: '#175cd3' },
    { id: 'income_business', name: '经营净收入', color: '#7b5cd6' },
    { id: 'income_property', name: '财产净收入', color: '#e08a2f' },
    { id: 'income_transfer', name: '转移净收入', color: '#1f9254' },
  ];

  // 八项消费分项：颜色固定，饼图与折线共用同一套，图例才对得上
  const SPEND_PARTS = [
    { id: 'spend_food', name: '食品烟酒', color: '#175cd3' },
    { id: 'spend_clothing', name: '衣着', color: '#7b5cd6' },
    { id: 'spend_housing', name: '居住', color: '#e08a2f' },
    { id: 'spend_household', name: '生活用品及服务', color: '#1f9254' },
    { id: 'spend_transport', name: '交通通信', color: '#c2410c' },
    { id: 'spend_education', name: '教育文化娱乐', color: '#0e7490' },
    { id: 'spend_medical', name: '医疗保健', color: '#a21caf' },
    { id: 'spend_other', name: '其他用品及服务', color: '#6b7280' },
  ];

  const COMPARE = [
    { id: 'urban_income', name: '城镇收入', color: '#175cd3' },
    { id: 'rural_income', name: '农村收入', color: '#5b8def' },
    { id: 'urban_spend', name: '城镇支出', color: '#e08a2f' },
    { id: 'rural_spend', name: '农村支出', color: '#f0b357' },
  ];

  const COLOR = {
    ink: '#16181d',
    muted: '#7b8391',
    line: '#e8eaee',
    lineStrong: '#d9dce2',
    accent: '#175cd3',
    violet: '#7b5cd6',
    orange: '#e08a2f',
    up: '#d14343',
    down: '#1f9254',
    flat: '#98a1ae',
  };

  // 用户可选的时间范围存本地：改默认值时必须同时升级这个键名（v1 -> v2）
  const RANGE_KEY = 'livelihood.income.range.v1';
  const DEFAULT_RANGE = 'all';

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
    footMeta: $('foot-meta'),
    pieSub: $('pie-sub'),
  };

  /* ---------------- 本地偏好 ---------------- */

  function loadPref() {
    try {
      const raw = localStorage.getItem(RANGE_KEY);
      if (!raw) return;
      const pref = JSON.parse(raw);
      if (!pref) return;
      if (pref.range === 'custom') {
        if (/^\d{4}$/.test(pref.from || '') && /^\d{4}$/.test(pref.to || '')) {
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

  /** 绝对值展示：带量纲 */
  function fmtValue(ind, v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return isGrowth(ind) ? fmtNum(v, ind.decimals) + '%' : fmtNum(v, ind.decimals) + ' ' + ind.unit;
  }

  /** 差值的量纲：增速用「个百分点」，金额用「元」 */
  function deltaUnit(ind) {
    return isGrowth(ind) ? ' 个百分点' : ' ' + ind.unit;
  }

  function fmtDelta(ind, d) {
    if (d === null || d === undefined || !isFinite(d)) return '—';
    return fmtSigned(d, isGrowth(ind) ? 1 : ind.decimals) + deltaUnit(ind);
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

  function yearCn(y) {
    if (!y) return '—';
    return y + ' 年';
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

  function yearsOf() {
    const ind = state.data && state.data.indicators[0];
    return ind ? ind.points.map((p) => p.year) : [];
  }

  function pointAt(id, year) {
    const ind = byId(id);
    if (!ind) return null;
    const hit = ind.points.filter((p) => p.year === year)[0];
    return hit && hit.value !== null ? hit.value : null;
  }

  /** 该指标在所选区间内最后一个有数据的点 */
  function lastPoint(ind) {
    if (!ind) return null;
    const hit = ind.points.filter((p) => p.value !== null);
    return hit.length ? hit[hit.length - 1] : null;
  }

  /** 上一个有数据的点（可能不是紧邻年份，年份会一并显示） */
  function prevPoint(ind, last) {
    if (!ind || !last) return null;
    const hit = ind.points.filter((p) => p.value !== null && p.year < last.year);
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
      grid: { left: 44, right: 18, top: 34, bottom: 28, containLabel: true },
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
        axisLabel: { color: COLOR.muted, fontSize: 11, hideOverlap: true },
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
        smooth: 0.25,
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

  /** 折线图的 tooltip：统一按「元」或「%」拼行 */
  function axisTooltip(years, unit, decimals) {
    return (params) => {
      const head = yearCn(years[params[0].dataIndex]);
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

  function renderIncomeSpend() {
    const years = yearsOf();
    if (!years.length) return emptyChart('chart-income-spend', '暂无数据');
    const option = baseOption();
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 0);
    option.tooltip.formatter = axisTooltip(years, ' 元', 0);
    option.series = [
      lineSeries('人均可支配收入', seriesOf('income_value'), COLOR.accent, {
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
      lineSeries('人均消费支出', seriesOf('spend_value'), COLOR.orange),
    ];
    chartOf('chart-income-spend').setOption(option, true);
  }

  function renderYoy() {
    const years = yearsOf();
    if (!years.length) return emptyChart('chart-yoy', '暂无数据');
    const option = baseOption();
    option.grid.top = 34;
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}%';
    option.tooltip.formatter = axisTooltip(years, '%', 1);
    option.series = [
      lineSeries('收入名义增速', seriesOf('income_yoy'), COLOR.accent, {
        markLine: {
          silent: true,
          symbol: 'none',
          label: { formatter: '0%', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
          lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      }),
      lineSeries('支出名义增速', seriesOf('spend_yoy'), COLOR.orange),
    ];
    chartOf('chart-yoy').setOption(option, true);
  }

  /** 饼图：用最新一个「八项都有值」的年度，缺分项的年份不凑图 */
  function latestFullSpendYear() {
    const years = yearsOf();
    for (let i = years.length - 1; i >= 0; i -= 1) {
      const y = years[i];
      const values = SPEND_PARTS.map((p) => pointAt(p.id, y));
      const hit = values.filter((v) => v !== null);
      if (hit.length === SPEND_PARTS.length) return y;
    }
    // 没有全年份都齐的，就退到最新一个「至少有一项」的年度（饼图会缺角，但图注会写清）
    for (let i = years.length - 1; i >= 0; i -= 1) {
      const y = years[i];
      if (SPEND_PARTS.some((p) => pointAt(p.id, y) !== null)) return y;
    }
    return '';
  }

  function renderPie() {
    const year = latestFullSpendYear();
    if (!year) return emptyChart('chart-pie', '暂无数据');
    const rows = SPEND_PARTS.map((p) => ({ name: p.name, color: p.color, value: pointAt(p.id, year) })).filter(
      (x) => x.value !== null && x.value > 0
    );
    if (!rows.length) return emptyChart('chart-pie', '暂无数据');

    const total = rows.reduce((sum, x) => sum + x.value, 0);
    const share = new Map();
    rows.forEach((x) => share.set(x.name, Math.round((x.value / total) * 1000) / 10));

    el.pieSub.textContent =
      year + ' 年 · 八项合计 ' + fmtNum(total, 0) + ' 元；占比由官方分项值直接相除得出，服务性消费不计入';

    const chart = chartOf('chart-pie');
    chart.clear();
    chart.setOption(
      {
        animationDuration: 420,
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(22,24,29,0.92)',
          borderWidth: 0,
          textStyle: { color: '#fff', fontSize: 12 },
          formatter: (p) =>
            p.name + '<br/>' + fmtNum(p.value, 0) + ' 元　' + share.get(p.name) + '%',
        },
        legend: {
          type: 'scroll',
          orient: 'vertical',
          right: 0,
          top: 'middle',
          icon: 'roundRect',
          itemWidth: 8,
          itemHeight: 8,
          itemGap: 9,
          textStyle: { color: COLOR.muted, fontSize: 12 },
          formatter: (name) => name + '　' + share.get(name) + '%',
        },
        title: {
          text: year,
          subtext: fmtNum(total, 0) + ' 元',
          left: '32%',
          top: '40%',
          textAlign: 'center',
          textStyle: { fontSize: 17, fontWeight: 600, color: COLOR.ink },
          subtextStyle: { fontSize: 11, color: COLOR.muted },
        },
        series: [
          {
            type: 'pie',
            radius: ['44%', '68%'],
            center: ['32%', '52%'],
            avoidLabelOverlap: true,
            label: { show: false },
            labelLine: { show: false },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            data: rows.map((x) => ({ name: x.name, value: x.value, itemStyle: { color: x.color } })),
          },
        ],
      },
      true
    );
  }

  function renderIncomeParts() {
    const years = yearsOf();
    if (!years.length) return emptyChart('chart-income-parts', '暂无数据');
    const option = baseOption();
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 0);
    option.tooltip.formatter = axisTooltip(years, ' 元', 0);
    option.series = INCOME_PARTS.map((p) => lineSeries(p.name, seriesOf(p.id), p.color));
    chartOf('chart-income-parts').setOption(option, true);
  }

  function renderSpendParts() {
    const years = yearsOf();
    if (!years.length) return emptyChart('chart-spend-parts', '暂无数据');
    const option = baseOption();
    option.legend.type = 'scroll';
    option.legend.itemGap = 10;
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 0);
    option.tooltip.formatter = axisTooltip(years, ' 元', 0);
    option.series = SPEND_PARTS.map((p) =>
      lineSeries(p.name, seriesOf(p.id), p.color, { lineStyle: { width: 1.6, color: p.color } })
    );
    chartOf('chart-spend-parts').setOption(option, true);
  }

  function renderUrbanRural() {
    const years = yearsOf();
    if (!years.length) return emptyChart('chart-urban-rural', '暂无数据');
    const option = baseOption();
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = (v) => fmtNum(v, 0);
    option.tooltip.formatter = axisTooltip(years, ' 元', 0);
    option.series = COMPARE.map((p) =>
      lineSeries(
        p.name,
        seriesOf(p.id),
        p.color,
        // 支出用虚线，和收入区分开（两者量级接近，只靠颜色容易看混）
        p.id.indexOf('spend') === 0 ? { lineStyle: { width: 2, color: p.color, type: 'dashed' } } : {}
      )
    );
    chartOf('chart-urban-rural').setOption(option, true);
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
      const prev = prevPoint(ind, latest);

      let deltaHtml = '<span class="kpi-delta flat">—</span>';
      if (latest && prev) {
        const d = Math.round((latest.value - prev.value) * 100) / 100;
        deltaHtml = '<span class="kpi-delta ' + signClass(d) + '">较上年 ' + fmtDelta(ind, d) + '</span>';
      }

      const valueText = latest
        ? isGrowth(ind)
          ? fmtSigned(latest.value, ind.decimals) + '<small>%</small>'
          : fmtNum(latest.value, ind.decimals) + '<small>' + ind.unit + '</small>'
        : '—';

      card.innerHTML =
        '<div class="kpi-label">' +
        cfg.label +
        (ind.stale ? ' <span class="tag warn">待更新</span>' : '') +
        '</div>' +
        '<div class="kpi-value ' +
        (isGrowth(ind) ? signClass(latest ? latest.value : null) : '') +
        '">' +
        valueText +
        '</div>' +
        '<div class="kpi-foot"><span>' +
        yearCn(latest ? latest.year : '') +
        '</span>' +
        deltaHtml +
        '</div>';

      el.kpiRow.appendChild(card);
    });
  }

  function renderTable() {
    if (!state.data) return;
    el.table.innerHTML = '';
    const groups = state.data.groups || [];
    const order = groups.length ? groups.map((g) => g.key) : [''];

    order.forEach((key) => {
      const rows = state.data.indicators.filter((x) => (key ? x.group === key : true));
      if (!rows.length) return;
      const group = groups.filter((g) => g.key === key)[0];

      if (group) {
        const head = document.createElement('tr');
        head.className = 'group-row';
        head.innerHTML =
          '<td colspan="7">' + esc(group.label) + (group.note ? '　·　' + esc(group.note) : '') + '</td>';
        el.table.appendChild(head);
      }

      rows.forEach((ind) => {
        const latest = lastPoint(ind);
        const prev = prevPoint(ind, latest);
        const delta = latest && prev ? Math.round((latest.value - prev.value) * 100) / 100 : null;

        const tr = document.createElement('tr');
        const statusText = ind.stale ? (ind.lastError ? '回退缓存' : '待更新') : '正常';
        const statusCls = ind.stale ? 'warn' : 'ok';
        tr.innerHTML =
          '<td>' +
          esc(ind.label) +
          '</td>' +
          '<td class="num ' +
          (isGrowth(ind) ? signClass(latest ? latest.value : null) : '') +
          '">' +
          (latest ? fmtValue(ind, latest.value) : '—') +
          '</td>' +
          '<td class="num">' +
          (prev ? fmtValue(ind, prev.value) : '—') +
          '</td>' +
          '<td class="num ' +
          signClass(delta) +
          '">' +
          fmtDelta(ind, delta) +
          '</td>' +
          '<td>' +
          yearCn(latest ? latest.year : '') +
          '</td>' +
          '<td>' +
          (ind.source === 'nbs' ? '国家统计局' : '—') +
          '</td>' +
          '<td><span class="tag ' +
          statusCls +
          '" title="' +
          esc(ind.lastError || '') +
          '">' +
          statusText +
          '</span></td>';
        el.table.appendChild(tr);
      });
    });
  }

  /* ---------------- 状态栏 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.title = text;
  }

  // 首次运行/缓存落后时请求会持续十几秒：超过 3 秒还没回来就换一句提示，避免用户以为卡住
  let slowHintTimer = null;

  function hintSlow() {
    clearTimeout(slowHintTimer);
    if (state.data) return;
    slowHintTimer = setTimeout(function () {
      setStatus('首次运行或缓存落后，正在向统计局补齐数据，需十几秒…');
    }, 3000);
  }

  function clearHint() {
    clearTimeout(slowHintTimer);
  }

  /** 状态栏只看服务端给的 stale / errors，不自己猜年份 */
  function applyStatus(json) {
    const staleList = json.indicators.filter((x) => x.stale);
    const busy = json.refreshing ? '（后台补齐中…）' : '';
    if (json.errors && json.errors.length) {
      setStatus('上游异常，' + staleList.length + ' 个指标已回退缓存' + busy, 'warn');
      el.status.title = json.errors.join('\n');
      return;
    }
    if (!staleList.length) {
      const first = json.firstRun ? '　首次运行已把全部历史写入缓存' : '';
      setStatus(
        '数据完整　' + (json.fetched ? '本次回源 ' + json.fetched + ' 个指标' : '全部命中本地缓存') + busy + first,
        'ok'
      );
      return;
    }
    const expected = staleList
      .map((x) => x.expectedLatest)
      .filter(Boolean)
      .sort()
      .pop();
    const latest = staleList
      .map((x) => x.latestCached)
      .filter(Boolean)
      .sort()
      .pop();
    setStatus(
      staleList.length + ' 个指标尚未更新（上游最新 ' + yearCn(latest) + '，应发布到 ' + yearCn(expected) + '）' + busy,
      'warn'
    );
  }

  function renderMeta() {
    const d = state.data;
    if (!d) return;
    const latestAll = d.indicators
      .map((ind) => (lastPoint(ind) ? lastPoint(ind).year : ''))
      .filter(Boolean)
      .sort()
      .pop();
    el.rangeHint.textContent =
      '当前区间：' +
      yearCn(d.range.from) +
      ' ~ ' +
      yearCn(d.range.to) +
      '　' +
      d.range.label +
      '　共 ' +
      (yearsOf().length || 0) +
      ' 个年度；最新已入库年度 ' +
      yearCn(latestAll || '');

    el.footMeta.textContent =
      '生成时间 ' +
      new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false }) +
      '　耗时 ' +
      d.elapsedMs +
      ' ms　本次回源 ' +
      d.fetched +
      ' 个指标　缓存目录 ' +
      d.cache.dir +
      '（' +
      d.cache.files +
      ' 个年度文件）';
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

  const CHART_IDS = [
    'chart-income-spend',
    'chart-yoy',
    'chart-pie',
    'chart-income-parts',
    'chart-spend-parts',
    'chart-urban-rural',
  ];

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    clearTimeout(pollTimer);
    pollCount = 0;
    setStatus(force ? '正在重新向统计局请求…' : '正在读取数据…');
    hintSlow();

    try {
      const res = await fetch('/api/livelihood/income-expenditure?' + queryString(force), {
        headers: { Accept: 'application/json' },
      });
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
    renderIncomeSpend();
    renderYoy();
    renderPie();
    renderIncomeParts();
    renderSpendParts();
    renderUrbanRural();
    renderTable();
    renderMeta();
  }

  /* ---------------- 交互 ---------------- */

  function syncInputs(json) {
    if (!json || !json.history) return;
    el.from.min = json.history.from;
    el.to.max = json.range.to;
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
    custom.textContent = '自定义年份';
    el.range.appendChild(custom);

    const valid = state.range === 'custom' || keys.indexOf(state.range) >= 0;
    state.range = valid ? state.range : DEFAULT_RANGE;
    el.range.value = state.range;
    el.customBox.hidden = state.range !== 'custom';
  }

  function yearOk(v) {
    return /^\d{4}$/.test(v || '');
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
      if (yearOk(state.from) && yearOk(state.to)) load(false);
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
    if (state.range === 'custom' && yearOk(state.from) && yearOk(state.to)) load(false);
  });

  el.to.addEventListener('change', () => {
    state.to = el.to.value;
    savePref();
    if (state.range === 'custom' && yearOk(state.from) && yearOk(state.to)) load(false);
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

  // 服务端对「有缓存但可能滞后」的指标不阻塞首屏（先用缓存出图、后台回源），
  // 这里在后台跑完后自己再取一次把新数据换上去；最多补 10 次（约 30 秒），不无限轮询。
  let pollTimer = null;
  let pollCount = 0;

  function schedulePoll(json) {
    if (!json || !json.refreshing) {
      pollCount = 0;
      return;
    }
    if (pollCount >= 10) return; // 最多补 10 次（约 30 秒），不无限轮询
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, 3000);
  }

  async function pollOnce() {
    if (state.loading) return; // 用户正在切换区间，这次就不插队了
    pollCount += 1;
    try {
      const res = await fetch('/api/livelihood/income-expenditure?' + queryString(false), {
        headers: { Accept: 'application/json' },
      });
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
      const res = await fetch('/api/livelihood/income-expenditure?' + queryString(false), {
        headers: { Accept: 'application/json' },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);
      buildRangeSelect(json.presets);
      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);
      if (json.history) {
        el.from.min = json.history.from;
        el.to.max = json.range.to;
        if (state.range === 'custom' && yearOk(state.from) && yearOk(state.to)) {
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
