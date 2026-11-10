'use strict';

/**
 * 中国婚育与人口出生看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/livelihood/overview?range=...
 * 顶部时间选择一变，整页（KPI + 4 张图 + 明细表）全部按新区间重画。
 * 前端不判断「哪一年该有数」——那是服务端 lib/livelihood/policy.js 的事，这里只消费 stale 字段。
 */

(function () {
  // 只有这 4 个指标进 KPI，其余指标在明细表与图中出现
  const KPI_LIST = [
    { id: 'marriage_reg', label: '结婚登记' },
    { id: 'divorce_reg', label: '离婚登记' },
    { id: 'birth_rate', label: '人口出生率' },
    { id: 'natural_growth_rate', label: '人口自然增长率' },
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
  const RANGE_KEY = 'livelihood.range.v1';
  const DEFAULT_RANGE = '20';

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
    changeSub: $('change-sub'),
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

  function isRate(ind) {
    return ind.kind === 'rate';
  }

  function fmtNum(v, decimals) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const d = typeof decimals === 'number' ? decimals : 2;
    return v.toFixed(d);
  }

  function fmtSigned(v, decimals) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const s = v.toFixed(typeof decimals === 'number' ? decimals : 2);
    return (v > 0 ? '+' : '') + s;
  }

  /** 绝对值展示（表格「最新值」列）：带量纲 */
  function fmtValue(ind, v, withUnit) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const body = fmtNum(v, ind.decimals);
    if (!withUnit) return body;
    return body + (isRate(ind) ? '‰' : ' ' + ind.unit);
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

  /** 差值的量纲：千分率用「个千分点」，其余沿用指标单位 */
  function deltaUnit(ind) {
    return isRate(ind) ? ' 个千分点' : ' ' + ind.unit;
  }

  function fmtDelta(ind, d) {
    if (d === null || d === undefined || !isFinite(d)) return '—';
    return fmtSigned(d, ind.decimals) + deltaUnit(ind);
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

  /* ---------------- 各图 ---------------- */

  function renderMarriage() {
    const years = yearsOf();
    if (!years.length) return emptyChart('chart-marriage', '暂无数据');
    const option = baseOption();
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}';
    option.tooltip.formatter = (params) => {
      const head = yearCn(years[params[0].dataIndex]);
      const rows = params
        .map((p) => p.seriesName + '　' + (p.value === null || p.value === undefined ? '—' : fmtNum(p.value, 2) + ' 万对'))
        .join('<br/>');
      return head + '<br/>' + rows;
    };
    const series = [];
    if (byId('marriage_reg')) series.push(lineSeries('结婚登记', seriesOf('marriage_reg'), COLOR.accent));
    if (byId('divorce_reg')) series.push(lineSeries('离婚登记', seriesOf('divorce_reg'), COLOR.violet));
    option.series = series;
    chartOf('chart-marriage').setOption(option, true);
  }

  function renderFirst() {
    const years = yearsOf();
    const ind = byId('first_marriage_persons');
    if (!ind || !years.length) return emptyChart('chart-first', '暂无数据');
    const option = baseOption();
    option.grid.top = 16;
    option.legend.show = false;
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}';
    option.tooltip.formatter = (params) => {
      const p = params[0];
      return yearCn(years[p.dataIndex]) + '<br/>初婚人数　' + (p.value === null ? '—' : fmtNum(p.value, 2) + ' 万人');
    };
    option.series = [
      lineSeries('初婚人数', seriesOf('first_marriage_persons'), COLOR.orange, {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(224,138,47,0.18)' },
              { offset: 1, color: 'rgba(224,138,47,0.01)' },
            ],
          },
        },
      }),
    ];
    chartOf('chart-first').setOption(option, true);
  }

  /** 结婚登记的年度变化：相邻两点相减，区间首年没有上一年，故首柱为空 */
  function renderChange() {
    const years = yearsOf();
    const ind = byId('marriage_reg');
    if (!ind || !years.length) return emptyChart('chart-change', '暂无数据');
    const values = seriesOf('marriage_reg');
    const diffs = values.map((v, i) => {
      if (i === 0 || v === null || values[i - 1] === null) return null;
      return Math.round((v - values[i - 1]) * 100) / 100;
    });

    const hasDiff = diffs.some((v) => v !== null);
    if (!hasDiff) return emptyChart('chart-change', '所选区间内没有可对比的相邻年份');

    const option = baseOption();
    option.grid.top = 16;
    option.legend.show = false;
    option.xAxis.boundaryGap = true;
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}';
    option.tooltip.formatter = (params) => {
      const p = params[0];
      const v = p.value;
      const head = yearCn(years[p.dataIndex]) + ' 较上年';
      return head + '<br/>结婚登记　' + (v === null ? '—' : fmtSigned(v, 2) + ' 万对');
    };
    option.series = [
      {
        name: '较上年增减',
        type: 'bar',
        barMaxWidth: 16,
        data: diffs.map((v) => ({
          value: v,
          itemStyle: {
            color: v === null ? COLOR.flat : v >= 0 ? COLOR.up : COLOR.down,
            borderRadius: v !== null && v < 0 ? [3, 0, 0, 3] : [0, 3, 3, 0],
          },
        })),
      },
    ];
    chartOf('chart-change').setOption(option, true);
  }

  function renderRate() {
    const years = yearsOf();
    if (!years.length) return emptyChart('chart-rate', '暂无数据');
    const option = baseOption();
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}‰';
    option.tooltip.formatter = (params) => {
      const head = yearCn(years[params[0].dataIndex]);
      const rows = params
        .map((p) => p.seriesName + '　' + (p.value === null || p.value === undefined ? '—' : fmtNum(p.value, 2) + '‰'))
        .join('<br/>');
      return head + '<br/>' + rows;
    };
    const series = [];
    if (byId('birth_rate')) series.push(lineSeries('出生率', seriesOf('birth_rate'), COLOR.accent));
    if (byId('death_rate')) series.push(lineSeries('死亡率', seriesOf('death_rate'), COLOR.orange));
    if (byId('natural_growth_rate')) {
      series.push(
        lineSeries('自然增长率', seriesOf('natural_growth_rate'), COLOR.violet, {
          markLine: {
            silent: true,
            symbol: 'none',
            label: { formatter: '0‰ 线', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
            lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
            data: [{ yAxis: 0 }],
          },
        })
      );
    }
    option.series = series;
    chartOf('chart-rate').setOption(option, true);
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

      let deltaHtml = '';
      if (latest && prev) {
        const d = Math.round((latest.value - prev.value) * 100) / 100;
        deltaHtml = '<span class="kpi-delta ' + signClass(d) + '">较上年 ' + fmtDelta(ind, d) + '</span>';
      } else {
        deltaHtml = '<span class="kpi-delta flat">—</span>';
      }

      const valueText = latest
        ? fmtNum(latest.value, ind.decimals) + '<small>' + (isRate(ind) ? '‰' : ' ' + ind.unit) + '</small>'
        : '—';

      card.innerHTML =
        '<div class="kpi-label">' +
        cfg.label +
        (ind.stale ? ' <span class="tag warn">待更新</span>' : '') +
        '</div>' +
        '<div class="kpi-value ' +
        (isRate(ind) ? signClass(latest ? latest.value : null) : '') +
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
    state.data.indicators.forEach((ind) => {
      const latest = lastPoint(ind);
      const prev = prevPoint(ind, latest);
      const delta = latest && prev ? Math.round((latest.value - prev.value) * 100) / 100 : null;

      const tr = document.createElement('tr');
      const statusText = ind.stale ? (ind.lastError ? '回退缓存' : '待更新') : '正常';
      const statusCls = ind.stale ? 'warn' : 'ok';
      tr.innerHTML =
        '<td>' +
        ind.label +
        '</td>' +
        '<td class="num ' +
        (isRate(ind) ? signClass(latest ? latest.value : null) : '') +
        '">' +
        (latest ? fmtValue(ind, latest.value, true) : '—') +
        '</td>' +
        '<td class="num">' +
        (prev ? fmtValue(ind, prev.value, true) : '—') +
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
    // 服务端把回源放到了后台，先告诉用户数据还会自己变新
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
      '（' +
      d.range.label +
      '）　共 ' +
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

  const CHART_IDS = ['chart-marriage', 'chart-first', 'chart-change', 'chart-rate'];

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    clearTimeout(pollTimer);
    pollCount = 0;
    setStatus(force ? '正在重新向统计局请求…' : '正在读取数据…');
    hintSlow();

    try {
      const res = await fetch('/api/livelihood/overview?' + queryString(force), {
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
    renderMarriage();
    renderFirst();
    renderChange();
    renderRate();
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
      const res = await fetch('/api/livelihood/overview?' + queryString(false), {
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
      const res = await fetch('/api/livelihood/overview?' + queryString(false), {
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
