'use strict';

/**
 * 中国宏观经济指标看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/macro/overview?range=...
 * 顶部时间选择一变，整页（KPI + 5 张图 + 明细表）全部按新区间重画。
 * 前端不判断「哪个月该有数」——那是服务端 lib/macro/cache/policy.js 的事，这里只消费 stale 字段。
 */

(function () {
  const KPI_LIST = [
    { id: 'cpi_yoy', label: 'CPI 同比' },
    { id: 'cpi_core_yoy', label: '核心 CPI 同比' },
    { id: 'ppi_yoy', label: 'PPI 同比' },
    { id: 'pmi', label: '制造业 PMI' },
    { id: 'retail_yoy', label: '社零同比' },
    { id: 'm2_yoy', label: 'M2 同比' },
  ];

  const CPI_CLASS = [
    'cpi_food_yoy',
    'cpi_clothing_yoy',
    'cpi_housing_yoy',
    'cpi_household_yoy',
    'cpi_transport_yoy',
    'cpi_education_yoy',
    'cpi_medical_yoy',
    'cpi_misc_yoy',
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

  const state = {
    range: '60',
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
    classSub: $('class-sub'),
  };

  /* ---------------- 数值格式 ---------------- */

  function isPercentKind(kind) {
    return kind === 'index_yoy' || kind === 'index_mom' || kind === 'pct_yoy';
  }

  function fmtNum(v, decimals) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const d = typeof decimals === 'number' ? decimals : 1;
    return v.toFixed(d);
  }

  function fmtSigned(v, decimals) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const s = v.toFixed(typeof decimals === 'number' ? decimals : 1);
    return (v > 0 ? '+' : '') + s;
  }

  function fmtValue(ind, v, withUnit) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    let body;
    if (isPercentKind(ind.kind)) body = fmtSigned(v, ind.decimals) + '%';
    else if (ind.kind === 'amount') body = fmtAmount(v);
    else body = fmtNum(v, ind.decimals);
    if (!withUnit) return body;
    if (ind.kind === 'index_pmi') return body;
    return body;
  }

  function fmtAmount(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 10000) return (v / 10000).toFixed(2) + ' 万亿';
    return Math.round(v).toLocaleString('zh-CN') + ' 亿';
  }

  function signClass(v) {
    if (v === null || v === undefined || !isFinite(v)) return 'flat';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'flat';
  }

  /** 差值的量纲：百分比类指标用「个百分点」，PMI 用「点」 */
  function deltaUnit(ind) {
    if (ind.kind === 'index_pmi') return ' 点';
    if (isPercentKind(ind.kind)) return ' 个百分点';
    return '';
  }

  function fmtDelta(ind, d) {
    if (d === null || d === undefined || !isFinite(d)) return '—';
    if (ind.kind === 'amount') return (d > 0 ? '+' : '') + fmtAmount(d);
    return fmtSigned(d, ind.decimals) + deltaUnit(ind);
  }

  function monthCn(m) {
    if (!m) return '—';
    const p = m.split('-');
    return p[0] + '年' + Number(p[1]) + '月';
  }

  function monthAxis(m) {
    return m.slice(2).replace('-', '/');
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

  /* ---------------- 各图 ---------------- */

  function renderInflation() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-inflation', '暂无数据');
    const map = { cpi_yoy: COLOR.accent, cpi_core_yoy: COLOR.violet, ppi_yoy: COLOR.orange };
    const names = { cpi_yoy: 'CPI 同比', cpi_core_yoy: '核心 CPI 同比', ppi_yoy: 'PPI 同比' };
    const series = Object.keys(map)
      .map((id) => {
        const ind = byId(id);
        if (!ind) return null;
        return lineSeries(names[id], seriesOf(id), map[id], {
          markLine:
            id === 'cpi_yoy'
              ? {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
                  data: [{ yAxis: 0 }],
                }
              : undefined,
        });
      })
      .filter(Boolean);

    const option = baseOption();
    option.xAxis.data = months.map(monthAxis);
    option.yAxis.axisLabel.formatter = '{value}%';
    option.tooltip.formatter = (params) => {
      const head = monthCn(months[params[0].dataIndex]);
      const rows = params
        .map((p) => p.seriesName + '　' + (p.value === null || p.value === undefined ? '—' : fmtSigned(p.value, 1) + '%'))
        .join('<br/>');
      return head + '<br/>' + rows;
    };
    option.series = series;
    chartOf('chart-inflation').setOption(option, true);
  }

  function renderMom() {
    const months = monthsOf();
    const ind = byId('cpi_mom');
    if (!ind) return emptyChart('chart-mom', '暂无数据');
    const values = seriesOf('cpi_mom');
    const data = values.map((v) => ({
      value: v,
      itemStyle: { color: v === null ? COLOR.flat : v >= 0 ? COLOR.up : COLOR.down, borderRadius: 2 },
    }));

    const option = baseOption();
    option.grid.top = 16;
    option.legend.show = false;
    option.xAxis.boundaryGap = true;
    option.xAxis.data = months.map(monthAxis);
    option.yAxis.axisLabel.formatter = '{value}%';
    option.tooltip.formatter = (params) => {
      const p = params[0];
      return monthCn(months[p.dataIndex]) + '<br/>CPI 环比　' + (p.value === null ? '—' : fmtSigned(p.value, 1) + '%');
    };
    option.series = [
      {
        name: 'CPI 环比',
        type: 'bar',
        data: data,
        barMaxWidth: 18,
      },
    ];
    chartOf('chart-mom').setOption(option, true);
  }

  function renderPmi() {
    const months = monthsOf();
    const ind = byId('pmi');
    if (!ind) return emptyChart('chart-pmi', '暂无数据');
    const option = baseOption();
    option.grid.top = 16;
    option.legend.show = false;
    option.xAxis.data = months.map(monthAxis);
    option.yAxis.min = (v) => Math.min(48, Math.floor(v.min));
    option.yAxis.max = (v) => Math.max(52, Math.ceil(v.max));
    option.tooltip.formatter = (params) => {
      const p = params[0];
      const v = p.value;
      const tail = v === null ? '' : v >= 50 ? '　扩张' : '　收缩';
      return monthCn(months[p.dataIndex]) + '<br/>制造业 PMI　' + (v === null ? '—' : fmtNum(v, 1)) + tail;
    };
    option.series = [
      lineSeries('制造业 PMI', seriesOf('pmi'), COLOR.accent, {
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
        markLine: {
          silent: true,
          symbol: 'none',
          label: { formatter: '荣枯线 50', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
          lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
          data: [{ yAxis: 50 }],
        },
      }),
    ];
    chartOf('chart-pmi').setOption(option, true);
  }

  function renderDemand() {
    const months = monthsOf();
    if (!months.length) return emptyChart('chart-demand', '暂无数据');
    const option = baseOption();
    option.xAxis.data = months.map(monthAxis);
    option.yAxis.axisLabel.formatter = '{value}%';
    option.tooltip.formatter = (params) => {
      const head = monthCn(months[params[0].dataIndex]);
      const rows = params
        .map((p) => p.seriesName + '　' + (p.value === null || p.value === undefined ? '—' : fmtSigned(p.value, 1) + '%'))
        .join('<br/>');
      return head + '<br/>' + rows;
    };
    const series = [];
    const retail = byId('retail_yoy');
    if (retail) series.push(lineSeries('社零同比', seriesOf('retail_yoy'), COLOR.up));
    const m2 = byId('m2_yoy');
    if (m2) series.push(lineSeries('M2 同比', seriesOf('m2_yoy'), COLOR.accent));
    option.series = series;
    chartOf('chart-demand').setOption(option, true);
  }

  function renderClass() {
    const ref = byId('cpi_yoy');
    if (!ref) return emptyChart('chart-class', '暂无数据');
    const last = lastPoint(ref);
    if (!last) return emptyChart('chart-class', '所选区间内没有已发布数据');

    const rows = CPI_CLASS.map((id) => {
      const ind = byId(id);
      if (!ind) return null;
      const pt = ind.points.filter((p) => p.month === last.month)[0];
      return { name: ind.shortLabel, value: pt && pt.value !== null ? pt.value : null };
    }).filter(Boolean);
    if (!rows.length) return emptyChart('chart-class', '暂无分项数据');

    el.classSub.textContent = monthCn(last.month) + ' 各类同比（%），按涨幅排序';

    rows.sort((a, b) => (b.value || 0) - (a.value || 0));

    const option = baseOption();
    option.grid = { left: 74, right: 56, top: 10, bottom: 10, containLabel: true };
    option.legend.show = false;
    option.xAxis = {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLOR.muted, fontSize: 11, formatter: '{value}%' },
      splitLine: { lineStyle: { color: COLOR.line } },
    };
    option.yAxis = {
      type: 'category',
      inverse: true,
      data: rows.map((x) => x.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLOR.ink, fontSize: 12 },
    };
    option.tooltip.formatter = (params) => {
      const p = params[0];
      return p.name + '<br/>' + monthCn(last.month) + ' 同比　' + (p.value === null ? '—' : fmtSigned(p.value, 1) + '%');
    };
    option.series = [
      {
        name: '同比',
        type: 'bar',
        barMaxWidth: 16,
        data: rows.map((x) => ({
          value: x.value,
          itemStyle: {
            color: x.value === null ? COLOR.flat : x.value >= 0 ? COLOR.up : COLOR.down,
            borderRadius: x.value !== null && x.value < 0 ? [3, 0, 0, 3] : [0, 3, 3, 0],
          },
        })),
        label: {
          show: true,
          position: 'right',
          color: COLOR.muted,
          fontSize: 11,
          formatter: (p) => (p.value === null ? '—' : fmtSigned(p.value, 1) + '%'),
        },
      },
    ];
    chartOf('chart-class').setOption(option, true);
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
      const prev = latest
        ? ind.points
            .filter((p) => p.value !== null && p.month < latest.month)
            .slice(-1)[0] || null
        : null;

      let deltaHtml = '';
      if (latest && prev) {
        const d = latest.value - prev.value;
        deltaHtml = '<span class="kpi-delta ' + signClass(d) + '">较上期 ' + fmtDelta(ind, d) + '</span>';
      } else {
        deltaHtml = '<span class="kpi-delta flat">—</span>';
      }

      const valueText = latest
        ? ind.kind === 'amount'
          ? fmtAmount(latest.value)
          : isPercentKind(ind.kind)
            ? fmtSigned(latest.value, ind.decimals) + '<small>%</small>'
            : fmtNum(latest.value, ind.decimals)
        : '—';

      card.innerHTML =
        '<div class="kpi-label">' +
        cfg.label +
        (ind.stale ? ' <span class="tag warn">待更新</span>' : '') +
        '</div>' +
        '<div class="kpi-value ' +
        (isPercentKind(ind.kind) ? signClass(latest ? latest.value : null) : '') +
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

  function renderTable() {
    if (!state.data) return;
    el.table.innerHTML = '';
    state.data.indicators.forEach((ind) => {
      const latest = lastPoint(ind);
      const prev = latest
        ? ind.points.filter((p) => p.value !== null && p.month < latest.month).slice(-1)[0] || null
        : null;
      const delta = latest && prev ? latest.value - prev.value : null;

      const tr = document.createElement('tr');
      const statusText = ind.stale ? (ind.lastError ? '回退缓存' : '待更新') : '正常';
      const statusCls = ind.stale ? 'warn' : 'ok';
      tr.innerHTML =
        '<td>' +
        ind.label +
        '</td>' +
        '<td class="num ' +
        (isPercentKind(ind.kind) ? signClass(latest ? latest.value : null) : '') +
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
        monthCn(latest ? latest.month : '') +
        '</td>' +
        '<td>' +
        (ind.source === 'dbnomics' ? 'DBnomics 镜像' : ind.source === 'nbs' ? '国家统计局' : '—') +
        '</td>' +
        '<td><span class="tag ' +
        statusCls +
        '" title="' +
        (ind.lastError || '') +
        '">' +
        statusText +
        '</span></td>';
      el.table.appendChild(tr);
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

  /** 状态栏只看服务端给的 stale / errors，不自己猜月份 */
  function applyStatus(json) {
    const staleList = json.indicators.filter((x) => x.stale);
    // 服务端把回源放到了后台，先告诉用户数据还会自己变新
    const busy = json.refreshing ? '（后台补齐中…）' : '';
    if (json.errors && json.errors.length) {
      setStatus('上游异常，' + staleList.length + ' 个指标已回退缓存' + busy, 'warn');
      el.status.title = json.errors.join('\n');
      return;
    }
    if (!staleList.length) {
      const first = json.firstRun ? '　首次运行已把全部历史写入缓存' : '';
      setStatus('数据完整　' + (json.fetched ? '本次回源 ' + json.fetched + ' 个指标' : '全部命中本地缓存') + busy + first, 'ok');
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
      staleList.length + ' 个指标尚未更新（上游最新 ' + monthCn(latest) + '，应发布到 ' + monthCn(expected) + '）' + busy,
      'warn'
    );
  }

  function renderMeta() {
    const d = state.data;
    if (!d) return;
    const latestAll = d.indicators
      .map((ind) => (lastPoint(ind) ? lastPoint(ind).month : ''))
      .filter(Boolean)
      .sort()
      .pop();
    el.rangeHint.textContent =
      '当前区间：' +
      monthCn(d.range.from) +
      ' ~ ' +
      monthCn(d.range.to) +
      '（' +
      d.range.label +
      '）　共 ' +
      (monthsOf().length || 0) +
      ' 个月；最新已发布期别 ' +
      monthCn(latestAll || '');

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
      ' 个月度文件）';
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

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    clearTimeout(pollTimer);
    pollCount = 0;
    setStatus(force ? '正在重新向统计局请求…' : '正在读取数据…');
    hintSlow();

    try {
      const res = await fetch('/api/macro/overview?' + queryString(force), { headers: { Accept: 'application/json' } });
      const json = await res.json();
      if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);

      state.data = json;
      renderAll();
      applyStatus(json);
      schedulePoll(json);

      if (json.history) {
        el.from.min = json.history.from;
        el.to.max = json.range.to;
        if (!el.from.value) el.from.value = json.range.from;
        if (!el.to.value) el.to.value = json.range.to;
      }
    } catch (e) {
      setStatus('加载失败：' + (e.message || e), 'error');
      if (!state.data) ['chart-inflation', 'chart-mom', 'chart-pmi', 'chart-demand', 'chart-class'].forEach((id) => emptyChart(id, '加载失败'));
    } finally {
      clearHint();
      state.loading = false;
      el.refresh.disabled = false;
    }
  }

  function renderAll() {
    renderKpi();
    renderInflation();
    renderMom();
    renderPmi();
    renderDemand();
    renderClass();
    renderTable();
    renderMeta();
  }

  /* ---------------- 交互 ---------------- */

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
    custom.textContent = '自定义区间';
    el.range.appendChild(custom);

    state.range = keys.indexOf(state.range) >= 0 ? state.range : '60';
    el.range.value = state.range;
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
      if (state.from && state.to) load(false);
      return;
    }
    load(false);
  });

  el.from.addEventListener('change', () => {
    state.from = el.from.value;
    if (state.range === 'custom' && state.from && state.to) load(false);
  });

  el.to.addEventListener('change', () => {
    state.to = el.to.value;
    if (state.range === 'custom' && state.from && state.to) load(false);
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
  // 落后 3 期以上的指标由服务端直接等补齐，不走这条路径。
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
      const res = await fetch('/api/macro/overview?' + queryString(false), { headers: { Accept: 'application/json' } });
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
    // 先拿一次概况：既取数据，也拿到服务端支持的预设区间
    setStatus('正在连接本地服务…');
    hintSlow();
    try {
      const res = await fetch('/api/macro/overview?range=60', { headers: { Accept: 'application/json' } });
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
        el.from.value = json.range.from;
        el.to.value = json.range.to;
        if (!el.from.value) el.from.value = json.history.from;
        if (!el.to.value) el.to.value = json.range.to;
      }
    } catch (e) {
      setStatus('加载失败：' + (e.message || e) + '（确认本地服务已启动）', 'error');
    } finally {
      clearHint();
    }
  })();
})();
