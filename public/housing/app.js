/* ============================================================
   70 城房价指数看板 · 前端逻辑
   数据来自本地 /api/nbs70（服务端抓取国家统计局月报并解析）
   ============================================================ */

(function () {
  'use strict';

  /** 一次性把全部历史（2011 年至今）拉到本地缓存，顶部的时间范围只影响展示 */
  var LOAD_MONTHS = 200;
  var RANGE_KEY = 'nbs70.range.v2';
  var POLL_INTERVAL = 1200;

  /** 默认展示近 5 年：最近 5 年既能看清周期，又不至于 189 条柱子挤成一团 */
  var RANGE_DEFAULT = { preset: '60', from: '', to: '' };

  function readRange() {
    // 地址栏优先：?range=36 或 ?from=2022-01&to=2024-12，方便直接把当前区间发给别人
    var qsFrom = Board.qs('from');
    var qsTo = Board.qs('to');
    var qsPreset = Board.qs('range');
    if (qsFrom && qsTo) return { preset: 'custom', from: qsFrom, to: qsTo };
    if (qsPreset) return { preset: qsPreset, from: '', to: '' };
    try {
      var raw = localStorage.getItem(RANGE_KEY);
      if (!raw) return { preset: RANGE_DEFAULT.preset, from: '', to: '' };
      var o = JSON.parse(raw);
      if (!o || !o.preset) return { preset: RANGE_DEFAULT.preset, from: '', to: '' };
      return { preset: String(o.preset), from: o.from || '', to: o.to || '' };
    } catch (e) {
      return { preset: RANGE_DEFAULT.preset, from: '', to: '' };
    }
  }

  function saveRange() {
    try {
      localStorage.setItem(RANGE_KEY, JSON.stringify(state.range));
    } catch (e) {
      /* 隐私模式下写入会失败，忽略 */
    }
  }

  var TYPE_LABEL = { new: '新建商品住宅', second: '二手住宅' };
  var METRIC_LABEL = { mom: '环比', yoy: '同比' };
  var METRIC_TIP = { mom: '环比：与上月相比', yoy: '同比：与上年同月相比' };
  var TIER_LABEL = { 1: '一线', 2: '二线', 3: '三线' };
  var TIER_CLASS = { 1: 't1', 2: 't2', 3: 't3' };

  var UP = '#d14343';
  var DOWN = '#1f9254';
  var FLAT = '#98a1ae';
  var ACCENT = '#175cd3';
  var SECOND = '#f0662b';

  var LINE_PALETTE = [
    '#175cd3', '#f0662b', '#0f9d6e', '#8e5bd8',
    '#e0a53b', '#2f8fd8', '#6b5bd8', '#c86fa8'
  ];

  var AXIS_LABEL = { color: '#7b8391', fontSize: 11 };
  var SPLIT_LINE = { lineStyle: { color: '#eef0f3', type: [4, 4] } };
  var TOOLTIP_BASE = {
    backgroundColor: 'rgba(22,24,29,.92)',
    borderWidth: 0,
    padding: [8, 12],
    textStyle: { color: '#fff', fontSize: 12, lineHeight: 18 },
    extraCssText: 'border-radius:8px;box-shadow:0 10px 26px rgba(0,0,0,.22);',
  };

  var state = {
    type: 'new',
    metric: 'mom',
    selected: ['北京', '上海', '广州', '深圳'],
    focus: '北京',
    base: { city: '', startMonth: '', endMonth: '' },
    range: readRange(),
    view: [],
    sort: { key: 'newYoy', dir: 1 },
    periods: [],
    /** 已渲染数据的指纹，值没变就不重绘（避免自动检查期间轮询重绘闪屏） */
    dataKey: '',
    cities: [],
    tierOf: {},
    snapshot: null,
    polling: null,
    loading: false,
  };

  var charts = {};

  /* 地址栏参数：房屋类型 / 对比口径 / 聚焦城市，便于把「某城某口径」的视图直接发给别人 */
  (function readViewQuery() {
    var type = Board.qs('type');
    var metric = Board.qs('metric');
    var city = Board.qs('city');
    if (type === 'new' || type === 'second') state.type = type;
    if (metric === 'mom' || metric === 'yoy') state.metric = metric;
    if (city) state.focus = city;
  })();

  /** 把当前视图（区间 + 类型 + 口径 + 聚焦城市）写回地址栏 */
  function syncQuery() {
    var r = state.range;
    var custom = r.preset === 'custom';
    Board.setQs({
      range: custom ? null : r.preset,
      from: custom ? r.from : null,
      to: custom ? r.to : null,
      type: state.type,
      metric: state.metric,
      city: state.focus,
    });
  }

  /** 分段按钮的选中态由 state 决定：从 URL 进来时也要对齐，不能只靠 HTML 里的 is-active */
  function syncSegs() {
    [['segType', 'type'], ['segMetric', 'metric']].forEach(function (pair) {
      var box = $(pair[0]);
      if (!box) return;
      var items = box.querySelectorAll('.seg-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-active', items[i].getAttribute('data-value') === state[pair[1]]);
      }
    });
  }

  // ------------------------------------------------------------ 工具函数

  function $(id) {
    return document.getElementById(id);
  }

  function chartInstance(id) {
    var el = $(id);
    if (!el) return null;
    if (!charts[id]) {
      charts[id] = echarts.init(el, null, { renderer: 'canvas' });
    }
    return charts[id];
  }

  function toPct(indexValue) {
    if (indexValue === null || indexValue === undefined) return null;
    return Math.round((indexValue - 100) * 10) / 10;
  }

  /** 取某月、某类型、某城市的涨跌幅（已换算为 %） */
  function pct(period, type, city, metric) {
    var bucket = period && period[type];
    var rec = bucket && bucket[city];
    if (!rec) return null;
    return toPct(rec[metric]);
  }

  function fmtPct(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  }

  /** 取某月的环比指数原值（100 = 与上月持平） */
  function momIndex(period, type, city) {
    var bucket = period && period[type];
    var rec = bucket && bucket[city];
    if (!rec || rec.mom === null || rec.mom === undefined) return null;
    return rec.mom;
  }

  /** 在任意月份数组里查下标 */
  function monthIndex(arr, month) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].month === month) return i;
    }
    return -1;
  }

  /**
   * 根据顶部“时间范围”算出要展示的月份子集。
   * 全量数据常驻 state.periods，这里只是切一个视图，所有与时间相关的图表都读 state.view。
   */
  function applyRange() {
    var all = state.periods;
    var r = state.range;
    if (!all.length) {
      state.view = [];
      return;
    }
    if (r.preset === 'custom' && r.from && r.to) {
      var s = r.from;
      var e = r.to;
      if (s > e) {
        var t = s;
        s = e;
        e = t;
      }
      var picked = all.filter(function (p) {
        return p.month >= s && p.month <= e;
      });
      state.view = picked.length ? picked : all.slice();
      return;
    }
    var n = Number(r.preset);
    state.view = n > 0 && all.length > n ? all.slice(all.length - n) : all.slice();
  }

  /** 在当前展示区间里查下标 */
  function indexOfMonth(month) {
    return monthIndex(state.view, month);
  }

  function valClass(v) {
    if (v === null || v === undefined) return '';
    if (v > 0) return 'val-up';
    if (v < 0) return 'val-down';
    return 'val-flat';
  }

  function monthLabel(m) {
    if (!m) return '';
    var parts = m.split('-');
    return parts[0] + ' 年 ' + Number(parts[1]) + ' 月';
  }

  function latest() {
    return state.view.length ? state.view[state.view.length - 1] : null;
  }

  /** 统计某月某类型的涨/平/跌城市数 */
  function countStat(period, type, metric) {
    var res = { up: 0, flat: 0, down: 0, total: 0 };
    if (!period) return res;
    for (var i = 0; i < state.cities.length; i++) {
      var v = pct(period, type, state.cities[i], metric);
      if (v === null) continue;
      res.total++;
      if (v > 0) res.up++;
      else if (v < 0) res.down++;
      else res.flat++;
    }
    return res;
  }

  // ------------------------------------------------------------ 数据加载

  function fetchSnapshot(force) {
    var url = '/api/nbs70?months=' + LOAD_MONTHS + (force ? '&force=1' : '');
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('接口返回 ' + r.status);
      return r.json();
    });
  }

  function setBoot(title, desc, meta, isError) {
    var boot = $('boot');
    $('bootTitle').textContent = title;
    if (desc !== null) $('bootDesc').textContent = desc;
    $('bootMeta').textContent = meta || '';
    boot.classList.toggle('is-error', !!isError);
  }

  function showProgress(snap) {
    if (snap.phase === 'index') {
      $('progressBar').style.width = '8%';
      setBoot(
        '正在检索历史月报索引…',
        '首次需要翻查统计局的站内搜索，约 1 分钟；索引会缓存 6 小时，之后不用再等。',
        ''
      );
      return;
    }
    var pctDone = snap.total ? Math.round((snap.loaded / snap.total) * 100) : 0;
    $('progressBar').style.width = Math.max(6, pctDone) + '%';
    var bits = [];
    if (snap.total) bits.push('已解析 ' + snap.loaded + ' / ' + snap.total + ' 个月');
    if (snap.current) bits.push('当前：' + monthLabel(snap.current));
    var desc =
      snap.total > 60
        ? '历史数据较多（每月一篇、每篇约 1.3MB），首次加载约需 2–4 分钟，请勿关闭页面。'
        : null;
    setBoot('正在从国家统计局抓取数据…', desc, bits.join('　·　'));
  }

  function load(force) {
    if (state.loading) return;
    state.loading = true;
    var btn = $('refreshBtn');
    btn.disabled = true;
    btn.textContent = force ? '刷新中…' : '加载中…';

    fetchSnapshot(force)
      .then(function (snap) {
        handleSnapshot(snap);
      })
      .catch(function (err) {
        stopPolling();
        setBoot(
          '数据加载失败',
          '无法连接本地服务或统计局站点：' + err.message + '。请确认 server.js 正在运行，然后重试。',
          '',
          true
        );
        $('boot').classList.remove('is-hidden');
        $('page').hidden = true;
      })
      .then(function () {
        state.loading = false;
        btn.disabled = false;
        btn.textContent = '刷新数据';
      });
  }

  function handleSnapshot(snap) {
    state.snapshot = snap;
    var periods = (snap.periods || []).slice().sort(function (a, b) {
      return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
    });
    state.periods = periods;
    applyRange();

    if (!periods.length) {
      if (snap.status === 'error') {
        stopPolling();
        setBoot('抓取失败', '国家统计局站点访问异常：' + (snap.error || '未知错误'), '', true);
        return;
      }
      if (snap.status === 'ready') {
        stopPolling();
        setBoot(
          '未找到 70 城房价数据',
          '列表页解析结果为空，可能是统计局站点改版。可稍后重试，或手动核对 www.stats.gov.cn/sj/zxfb/ 的发布格式。',
          '',
          true
        );
        return;
      }
      showProgress(snap);
      $('boot').classList.remove('is-hidden');
      $('page').hidden = true;
      startPolling();
      return;
    }

    // 有数据就先渲染
    // 跨月自动检查期间 periods 不会变，没必要每次轮询都重绘一遍（会闪）
    var dataKey =
      periods.length +
      '|' +
      (periods.length ? periods[0].month : '') +
      '|' +
      (periods.length ? periods[periods.length - 1].month : '');
    $('boot').classList.add('is-hidden');
    // 先显示页面再画图：容器在 display:none 里量到的宽度是 0，图表会缩成一条
    $('page').hidden = false;
    if (dataKey !== state.dataKey) {
      state.dataKey = dataKey;
      buildCityOrder();
      renderAll();
    }

    if (snap.status === 'loading') {
      showProgress(snap);
      $('stamp').textContent = snap.autoCheck
        ? '正在检查有没有新月份…'
        : '抓取中 ' + snap.loaded + '/' + snap.total + ' 个月…';
      $('stamp').classList.remove('is-ok');
      startPolling();
    } else {
      stopPolling();
      var p = latest();
      var ds = snap.dataset || {};
      $('stamp').textContent =
        '数据月份 ' +
        monthLabel(p.month) +
        ' · 共 ' + periods.length + ' 个月' +
        (snap.dataset ? ' · 本地数据集' : ' · 已缓存');
      $('stamp').title = ds.checkedMonth
        ? '上次核对统计局：' + ds.checkedMonth + '（' + String(ds.checkedAt || '').slice(0, 10) + '）'
        : '尚未核对过统计局';
      $('stamp').classList.add('is-ok');
      if (snap.status === 'error') {
        $('stamp').textContent += '（部分月份抓取失败）';
      }
    }
  }

  function startPolling() {
    if (state.polling) return;
    state.polling = setInterval(function () {
      fetchSnapshot(false)
        .then(handleSnapshot)
        .catch(function () {
          /* 轮询失败静默忽略，等下一次 */
        });
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (state.polling) {
      clearInterval(state.polling);
      state.polling = null;
    }
  }

  /** 城市排序：一线 → 二线 → 三线，同档内保持统计局原始顺序 */
  function buildCityOrder() {
    var p = latest();
    if (!p || !p['new']) return;
    var names = Object.keys(p['new']);
    var buckets = { 1: [], 2: [], 3: [] };
    var tierOf = {};
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var t = (p['new'][n] && p['new'][n].tier) || 3;
      tierOf[n] = t;
      (buckets[t] || buckets[3]).push(n);
    }
    state.cities = buckets[1].concat(buckets[2], buckets[3]);
    state.tierOf = tierOf;
    if (state.cities.indexOf(state.focus) < 0) {
      state.focus = state.cities[0] || '';
    }
  }

  // ------------------------------------------------------------ 时间范围

  /** 同步顶部“时间范围”（快捷区间 + 自定义起止月）的选项与显隐 */
  function renderRangeControls() {
    var ps = state.periods;
    var sel = $('rangeSelect');
    sel.value = state.range.preset;
    if (!sel.value) {
      state.range.preset = RANGE_DEFAULT.preset;
      sel.value = RANGE_DEFAULT.preset;
    }

    var custom = state.range.preset === 'custom';
    $('rangeCustom').hidden = !custom;
    if (!custom || !ps.length) return;

    var opts = ps
      .map(function (p) {
        return '<option value="' + p.month + '">' + monthLabel(p.month) + '</option>';
      })
      .join('');
    $('rangeFrom').innerHTML = opts;
    $('rangeTo').innerHTML = opts;

    var first = ps[0].month;
    var last = ps[ps.length - 1].month;
    if (monthIndex(ps, state.range.from) < 0) state.range.from = first;
    if (monthIndex(ps, state.range.to) < 0) state.range.to = last;
    if (state.range.from > state.range.to) {
      var tmp = state.range.from;
      state.range.from = state.range.to;
      state.range.to = tmp;
    }
    $('rangeFrom').value = state.range.from;
    $('rangeTo').value = state.range.to;
  }

  // ------------------------------------------------------------ 渲染入口

  function renderAll() {
    syncSegs();
    syncQuery();
    renderRangeControls();
    renderStampSubs();
    renderKpis();
    renderChips();
    renderCitySelect();
    renderTrend();
    renderCount();
    renderRank();
    renderHeat();
    renderCityDetail();
    renderBaseControls();
    renderBaseIndex();
    renderTable();
  }

  function renderStampSubs() {
    var p = latest();
    $('metricNote').textContent = METRIC_TIP[state.metric];
    $('trendSub').textContent =
      TYPE_LABEL[state.type] + ' · ' + METRIC_LABEL[state.metric] + '涨跌幅（指数 − 100）';
    $('countSub').textContent =
      TYPE_LABEL[state.type] + ' · ' + METRIC_LABEL[state.metric] + ' · 每月 70 城分布';
    $('rankSub').textContent =
      monthLabel(p.month) + ' · ' + TYPE_LABEL[state.type] + METRIC_LABEL[state.metric] + '排序';
    $('heatSub').textContent =
      TYPE_LABEL[state.type] + ' · ' + METRIC_LABEL[state.metric] + '（可滚轮缩放、拖动右侧滑块查看全部 70 城）';
    $('citySub').textContent =
      state.focus + ' · ' + METRIC_LABEL[state.metric] + ' 新房 vs 二手';
    $('tableSub').textContent =
      monthLabel(p.month) + ' · 70 城全量对照 · 点击表头排序';
  }

  // ------------------------------------------------------------ KPI

  function kpiCard(opts) {
    return (
      '<div class="kpi">' +
      '<div class="kpi-label">' + opts.label + '</div>' +
      '<div class="kpi-value ' + (opts.tone || '') + '">' + opts.value +
      (opts.unit ? '<small>' + opts.unit + '</small>' : '') +
      '</div>' +
      (opts.foot ? '<div class="kpi-foot">' + opts.foot + '</div>' : '') +
      (opts.bar ? opts.bar : '') +
      '</div>'
    );
  }

  function barOf(stat) {
    if (!stat.total) return '';
    var u = (stat.up / stat.total) * 100;
    var f = (stat.flat / stat.total) * 100;
    var d = (stat.down / stat.total) * 100;
    return (
      '<div class="kpi-bar">' +
      '<i style="width:' + u + '%;background:' + UP + '"></i>' +
      '<i style="width:' + f + '%;background:' + FLAT + '"></i>' +
      '<i style="width:' + d + '%;background:' + DOWN + '"></i>' +
      '</div>'
    );
  }

  function footOf(stat) {
    return (
      '上涨 <b class="kpi-emph-up">' + stat.up + '</b>' +
      '<span class="sep">|</span>持平 <b>' + stat.flat + '</b>' +
      '<span class="sep">|</span>下跌 <b class="kpi-emph-down">' + stat.down + '</b>'
    );
  }

  function renderKpis() {
    var p = latest();
    var newMom = countStat(p, 'new', 'mom');
    var newYoy = countStat(p, 'new', 'yoy');
    var secMom = countStat(p, 'second', 'mom');
    var secYoy = countStat(p, 'second', 'yoy');

    var html = '';
    var full = state.view.length === state.periods.length;
    html += kpiCard({
      label: full ? '最新数据月份' : '区间末月',
      value: monthLabel(p.month),
      foot:
        '发布 ' + (p.publishedAt || '—') +
        '<span class="sep">|</span>区间 ' + state.view.length + ' / 全部 ' + state.periods.length + ' 个月',
    });
    html += kpiCard({
      label: '新房 · 环比上涨城市',
      value: newMom.up,
      unit: '/ ' + newMom.total + ' 城',
      tone: 'kpi-emph-up',
      foot: footOf(newMom),
      bar: barOf(newMom),
    });
    html += kpiCard({
      label: '二手 · 环比上涨城市',
      value: secMom.up,
      unit: '/ ' + secMom.total + ' 城',
      tone: 'kpi-emph-up',
      foot: footOf(secMom),
      bar: barOf(secMom),
    });
    html += kpiCard({
      label: '新房 · 同比下跌城市',
      value: newYoy.down,
      unit: '/ ' + newYoy.total + ' 城',
      tone: 'kpi-emph-down',
      foot: footOf(newYoy),
      bar: barOf(newYoy),
    });
    html += kpiCard({
      label: '二手 · 同比下跌城市',
      value: secYoy.down,
      unit: '/ ' + secYoy.total + ' 城',
      tone: 'kpi-emph-down',
      foot: footOf(secYoy),
      bar: barOf(secYoy),
    });

    $('kpis').innerHTML = html;
  }

  // ------------------------------------------------------------ 城市 chips

  function renderChips() {
    var wrap = $('chips');
    var frag = document.createDocumentFragment();

    var groups = document.createElement('span');
    groups.className = 'chip-group';
    [
      ['一线', 1],
      ['二线', 2],
      ['三线', 3],
    ].forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-mini';
      b.textContent = g[0];
      b.title = '选中全部' + g[0] + '城市';
      b.addEventListener('click', function () {
        var picked = state.cities.filter(function (c) {
          return state.tierOf[c] === g[1];
        });
        state.selected = picked;
        renderChips();
        renderTrend();
      });
      groups.appendChild(b);
    });
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chip-mini';
    clear.textContent = '清空';
    clear.addEventListener('click', function () {
      state.selected = [];
      renderChips();
      renderTrend();
    });
    groups.appendChild(clear);
    frag.appendChild(groups);

    state.cities.forEach(function (city) {
      var on = state.selected.indexOf(city) >= 0;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (on ? ' is-on' : '');
      b.textContent = city;
      b.addEventListener('click', function () {
        var i = state.selected.indexOf(city);
        if (i >= 0) state.selected.splice(i, 1);
        else state.selected.push(city);
        renderChips();
        renderTrend();
      });
      frag.appendChild(b);
    });

    wrap.innerHTML = '';
    wrap.appendChild(frag);
  }

  function renderCitySelect() {
    var sel = $('citySelect');
    sel.innerHTML = '';
    state.cities.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c + '（' + TIER_LABEL[state.tierOf[c]] + '）';
      if (c === state.focus) o.selected = true;
      sel.appendChild(o);
    });
  }

  // ------------------------------------------------------------ 图1 走势

  function renderTrend() {
    var inst = chartInstance('chartTrend');
    if (!inst) return;
    var ps = state.view;
    var months = ps.map(function (p) {
      return p.month.slice(2);
    });

    if (!state.selected.length) {
      inst.clear();
      inst.setOption({
        graphic: {
          type: 'text',
          left: 'center',
          top: 'middle',
          style: { text: '请在上方选择要对比的城市', fill: '#9aa1ad', fontSize: 13 },
        },
      });
      return;
    }

    var series = state.selected.map(function (city, i) {
      return {
        name: city,
        type: 'line',
        smooth: 0.28,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: months.length <= 14,
        lineStyle: { width: 2, color: LINE_PALETTE[i % LINE_PALETTE.length] },
        itemStyle: { color: LINE_PALETTE[i % LINE_PALETTE.length] },
        emphasis: { focus: 'series' },
        data: ps.map(function (p) {
          return pct(p, state.type, city, state.metric);
        }),
        ...(i === 0
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: '#c9ced8', type: 'dashed', width: 1 },
                label: { show: false },
                data: [{ yAxis: 0 }],
              },
            }
          : {}),
      };
    });

    inst.setOption(
      {
        animationDuration: 420,
        grid: { left: 46, right: 18, top: 34, bottom: 30 },
        tooltip: Object.assign({}, TOOLTIP_BASE, {
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: '#c8cdd6', type: 'dashed' } },
          valueFormatter: function (v) {
            return fmtPct(v);
          },
        }),
        legend: {
          type: 'scroll',
          top: 0,
          left: 0,
          itemWidth: 12,
          itemHeight: 3,
          itemGap: 14,
          textStyle: { color: '#48505e', fontSize: 11 },
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: months,
          axisLine: { lineStyle: { color: '#e3e6ec' } },
          axisTick: { show: false },
          axisLabel: AXIS_LABEL,
        },
        yAxis: {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: SPLIT_LINE,
          axisLabel: Object.assign({}, AXIS_LABEL, { formatter: '{value}%' }),
        },
        series: series,
      },
      true
    );
  }

  // ------------------------------------------------------------ 图2 涨跌城市数

  function renderCount() {
    var inst = chartInstance('chartCount');
    if (!inst) return;
    var ps = state.view;
    var months = ps.map(function (p) {
      return p.month.slice(2);
    });
    var ups = [];
    var flats = [];
    var downs = [];
    ps.forEach(function (p) {
      var s = countStat(p, state.type, state.metric);
      ups.push(s.up);
      flats.push(s.flat);
      downs.push(s.down);
    });

    function bar(name, data, color, stackTop) {
      return {
        name: name,
        type: 'bar',
        stack: 'c',
        barMaxWidth: 26,
        itemStyle: {
          color: color,
          borderRadius: stackTop ? [3, 3, 0, 0] : 0,
        },
        emphasis: { focus: 'series' },
        data: data,
      };
    }

    inst.setOption(
      {
        animationDuration: 420,
        grid: { left: 34, right: 14, top: 34, bottom: 30 },
        tooltip: Object.assign({}, TOOLTIP_BASE, {
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(23,92,211,.05)' } },
          formatter: function (params) {
            var head = '<b>' + params[0].axisValue + '</b>';
            var lines = params
              .slice()
              .reverse()
              .map(function (p) {
                return p.marker + p.seriesName + '　<b>' + p.value + '</b> 城';
              });
            return head + '<br/>' + lines.join('<br/>');
          },
        }),
        legend: {
          top: 0,
          left: 0,
          itemWidth: 10,
          itemHeight: 10,
          itemGap: 14,
          textStyle: { color: '#48505e', fontSize: 11 },
        },
        xAxis: {
          type: 'category',
          data: months,
          axisLine: { lineStyle: { color: '#e3e6ec' } },
          axisTick: { show: false },
          axisLabel: AXIS_LABEL,
        },
        yAxis: {
          type: 'value',
          max: 70,
          splitNumber: 4,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: SPLIT_LINE,
          axisLabel: Object.assign({}, AXIS_LABEL, { formatter: '{value}' }),
        },
        series: [
          bar('下跌', downs, DOWN, false),
          bar('持平', flats, FLAT, false),
          bar('上涨', ups, UP, true),
        ],
      },
      true
    );
  }

  // ------------------------------------------------------------ 图3 城市排行

  function renderRank() {
    var inst = chartInstance('chartRank');
    if (!inst) return;
    var p = latest();
    var rows = state.cities
      .map(function (c) {
        return { city: c, v: pct(p, state.type, c, state.metric) };
      })
      .filter(function (r) {
        return r.v !== null;
      })
      .sort(function (a, b) {
        return a.v - b.v; // 升序 → 横向条形图中数值最大的在最上方
      });

    var n = rows.length;
    var visible = 34;
    var startPct = n > visible ? ((n - visible) / n) * 100 : 0;

    inst.setOption(
      {
        animationDuration: 420,
        grid: { left: 62, right: 58, top: 8, bottom: 26 },
        tooltip: Object.assign({}, TOOLTIP_BASE, {
          trigger: 'item',
          formatter: function (pp) {
            var v = pp.value;
            return (
              '<b>' + pp.name + '</b>　' + TIER_LABEL[state.tierOf[pp.name]] + '<br/>' +
              TYPE_LABEL[state.type] + METRIC_LABEL[state.metric] + '：<b>' + fmtPct(v) + '</b>'
            );
          },
        }),
        xAxis: {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: SPLIT_LINE,
          axisLabel: Object.assign({}, AXIS_LABEL, { formatter: '{value}%' }),
        },
        yAxis: {
          type: 'category',
          data: rows.map(function (r) {
            return r.city;
          }),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: '#48505e', fontSize: 11, margin: 8 },
        },
        dataZoom: [
          { type: 'inside', yAxisIndex: 0, start: startPct, end: 100, zoomOnMouseWheel: true },
          {
            type: 'slider',
            yAxisIndex: 0,
            start: startPct,
            end: 100,
            right: 4,
            width: 10,
            showDetail: false,
            brushSelect: false,
            borderColor: 'transparent',
            backgroundColor: '#f4f6f9',
            fillerColor: 'rgba(23,92,211,.16)',
            handleSize: 0,
          },
        ],
        series: [
          {
            type: 'bar',
            barMaxWidth: 13,
            data: rows.map(function (r) {
              return {
                value: r.v,
                itemStyle: {
                  color: r.v > 0 ? UP : r.v < 0 ? DOWN : FLAT,
                  borderRadius: r.v >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3],
                },
              };
            }),
            label: {
              show: true,
              position: function (p2) {
                return p2.value >= 0 ? 'right' : 'left';
              },
              distance: 6,
              color: '#48505e',
              fontSize: 10,
              formatter: function (p2) {
                return fmtPct(p2.value);
              },
            },
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#c9ced8', width: 1 },
              label: { show: false },
              data: [{ xAxis: 0 }],
            },
          },
        ],
      },
      true
    );
  }

  // ------------------------------------------------------------ 图4 热力图

  function renderHeat() {
    var inst = chartInstance('chartHeat');
    if (!inst) return;
    // 月份太长时图会被压成一条，只展示尾部（最近 MAX_COLS 个月）
    var MAX_COLS = 60;
    var all = state.view;
    var ps = all.length > MAX_COLS ? all.slice(all.length - MAX_COLS) : all;
    var months = ps.map(function (p) {
      return p.month.slice(2);
    });
    var cities = state.cities;
    $('heatSub').textContent =
      '颜色越红涨幅越大，越绿跌幅越大（近 ' + ps.length + ' 个月 / 区间共 ' + all.length + ' 个月）';

    var data = [];
    var maxAbs = 0.6;
    for (var ci = 0; ci < cities.length; ci++) {
      for (var mi = 0; mi < ps.length; mi++) {
        var v = pct(ps[mi], state.type, cities[ci], state.metric);
        if (v === null) continue;
        if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
        data.push([mi, ci, v]);
      }
    }
    var bound = Math.max(0.5, Math.ceil(maxAbs * 10) / 10);

    var rowH = 15;
    var needZoom = cities.length * rowH > 500;
    var visible = Math.floor(500 / rowH);
    // yAxis 为 inverse，索引 0 在最上方；默认窗口固定从头部（一线城市）开始
    var endPct = needZoom ? (visible / cities.length) * 100 : 100;

    inst.setOption(
      {
        animationDuration: 420,
        grid: { left: 66, right: 20, top: 12, bottom: 52 },
        tooltip: Object.assign({}, TOOLTIP_BASE, {
          formatter: function (pp) {
            return (
              '<b>' + cities[pp.value[1]] + '</b>　' +
              monthLabel(ps[pp.value[0]].month) + '<br/>' +
              TYPE_LABEL[state.type] + METRIC_LABEL[state.metric] + '：<b>' +
              fmtPct(pp.value[2]) + '</b>'
            );
          },
        }),
        xAxis: {
          type: 'category',
          data: months,
          splitArea: { show: false },
          axisLine: { lineStyle: { color: '#e3e6ec' } },
          axisTick: { show: false },
          axisLabel: AXIS_LABEL,
        },
        yAxis: {
          type: 'category',
          data: cities,
          inverse: true,
          splitArea: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: '#48505e', fontSize: 11, margin: 8 },
        },
        visualMap: {
          min: -bound,
          max: bound,
          calculable: false,
          orient: 'horizontal',
          left: 'center',
          bottom: 4,
          itemWidth: 12,
          itemHeight: 120,
          textStyle: { color: '#7b8391', fontSize: 11 },
          formatter: function (v) {
            return (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%';
          },
          inRange: {
            color: ['#12673f', '#3f9d6b', '#a9d8bd', '#f0f4f2', '#f7d3cf', '#e0837c', '#bd2f2c'],
          },
        },
        dataZoom: needZoom
          ? [
              { type: 'inside', yAxisIndex: 0, start: 0, end: endPct },
              {
                type: 'slider',
                yAxisIndex: 0,
                start: 0,
                end: endPct,
                right: 2,
                width: 8,
                showDetail: false,
                brushSelect: false,
                borderColor: 'transparent',
                backgroundColor: '#f4f6f9',
                fillerColor: 'rgba(23,92,211,.16)',
                handleSize: 0,
              },
            ]
          : [],
        series: [
          {
            type: 'heatmap',
            data: data,
            itemStyle: { borderColor: '#fff', borderWidth: 1 },
            emphasis: {
              itemStyle: { borderColor: '#16181d', borderWidth: 1.5, shadowBlur: 6 },
            },
            progressive: 0,
          },
        ],
      },
      true
    );
  }

  // ------------------------------------------------------------ 图5 单城详情

  function renderCityDetail() {
    var inst = chartInstance('chartCity');
    if (!inst) return;
    var ps = state.view;
    var months = ps.map(function (p) {
      return p.month.slice(2);
    });
    var city = state.focus;

    function line(name, type, color, area) {
      return {
        name: name,
        type: 'line',
        smooth: 0.28,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: ps.length <= 14,
        lineStyle: { width: 2.2, color: color },
        itemStyle: { color: color },
        areaStyle: area
          ? {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(23,92,211,.18)' },
                { offset: 1, color: 'rgba(23,92,211,0)' },
              ]),
            }
          : null,
        emphasis: { focus: 'series' },
        data: ps.map(function (p) {
          return pct(p, type, city, state.metric);
        }),
      };
    }

    inst.setOption(
      {
        animationDuration: 420,
        grid: { left: 46, right: 18, top: 34, bottom: 30 },
        tooltip: Object.assign({}, TOOLTIP_BASE, {
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: '#c8cdd6', type: 'dashed' } },
          valueFormatter: function (v) {
            return fmtPct(v);
          },
        }),
        legend: {
          top: 0,
          left: 0,
          itemWidth: 12,
          itemHeight: 3,
          itemGap: 16,
          textStyle: { color: '#48505e', fontSize: 11 },
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: months,
          axisLine: { lineStyle: { color: '#e3e6ec' } },
          axisTick: { show: false },
          axisLabel: AXIS_LABEL,
        },
        yAxis: {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: SPLIT_LINE,
          axisLabel: Object.assign({}, AXIS_LABEL, { formatter: '{value}%' }),
        },
        series: [line('新建商品住宅', 'new', ACCENT, true), line('二手住宅', 'second', SECOND, false)],
      },
      true
    );
  }

  // ------------------------------------------------------------ 图6 定基指数

  /** 同步“城市 / 起点 / 终点”三个下拉框的选项与选中值 */
  function renderBaseControls() {
    var ps = state.view;
    if (!ps.length || !state.cities.length) return;

    var base = state.base;
    if (state.cities.indexOf(base.city) < 0) base.city = state.focus || state.cities[0];
    $('baseCity').innerHTML = state.cities
      .map(function (c) {
        return (
          '<option value="' + c + '"' + (c === base.city ? ' selected' : '') + '>' +
          c + '（' + TIER_LABEL[state.tierOf[c]] + '）</option>'
        );
      })
      .join('');

    var monthOpts = ps
      .map(function (p) {
        return '<option value="' + p.month + '">' + monthLabel(p.month) + '</option>';
      })
      .join('');
    $('baseStart').innerHTML = monthOpts;
    $('baseEnd').innerHTML = monthOpts;

    var first = ps[0].month;
    var last = ps[ps.length - 1].month;
    // 新加载的月份会向两侧扩展，已选的月份如果还在范围内就保持不变
    if (indexOfMonth(base.startMonth) < 0) base.startMonth = first;
    if (indexOfMonth(base.endMonth) < 0) base.endMonth = last;
    if (base.startMonth > base.endMonth) {
      var tmp = base.startMonth;
      base.startMonth = base.endMonth;
      base.endMonth = tmp;
    }
    $('baseStart').value = base.startMonth;
    $('baseEnd').value = base.endMonth;
  }

  /** 把区间内每月的环比指数链式累乘，起点置为 100 */
  function chainIndex(range, type, city) {
    var acc = 100;
    return range.map(function (p, i) {
      if (i > 0) {
        var m = momIndex(p, type, city);
        if (m !== null) acc = acc * (m / 100);
      }
      return Math.round(acc * 100) / 100;
    });
  }

  function renderBaseIndex() {
    var inst = chartInstance('chartBase');
    if (!inst) return;
    var ps = state.view;
    if (!ps.length) return;

    var s = indexOfMonth(state.base.startMonth);
    var e = indexOfMonth(state.base.endMonth);
    if (s < 0) s = 0;
    if (e < 0) e = ps.length - 1;
    if (e < s) e = s;

    var range = ps.slice(s, e + 1);
    var city = state.base.city;
    var months = range.map(function (p) {
      return p.month.slice(2);
    });

    if (range.length < 2) {
      $('baseSub').textContent = '起点与终点为同一个月，请把区间拉开至少 2 个月';
      inst.clear();
      inst.setOption({
        graphic: {
          type: 'text',
          left: 'center',
          top: 'middle',
          style: { text: '所选区间不足 2 个月', fill: '#9aa1ad', fontSize: 13 },
        },
      });
      return;
    }

    var newData = chainIndex(range, 'new', city);
    var secData = chainIndex(range, 'second', city);
    var lastNew = newData[newData.length - 1];
    var lastSec = secData[secData.length - 1];
    var newChg = Math.round((lastNew - 100) * 10) / 10;
    var secChg = Math.round((lastSec - 100) * 10) / 10;
    // 两条线尾值靠得太近时，尾标签会叠在一起看不清，此时不出标签，
    // 终值直接写在副标题里
    var showEndLabel = Math.abs(lastNew - lastSec) >= 4;

    $('baseSub').textContent =
      city + ' · ' + monthLabel(range[0].month) + ' → ' + monthLabel(range[range.length - 1].month) +
      ' · 新房 ' + lastNew.toFixed(1) + '（' + fmtPct(newChg) + '）' +
      ' / 二手 ' + lastSec.toFixed(1) + '（' + fmtPct(secChg) + '）' +
      '（不受上方开关影响）';

    function series(name, data, color, withBase) {
      return {
        name: name,
        type: 'line',
        smooth: 0.18,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: range.length <= 24,
        lineStyle: { width: 2.2, color: color },
        itemStyle: { color: color },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: color === ACCENT ? 'rgba(23,92,211,.16)' : 'rgba(240,102,43,.14)' },
            { offset: 1, color: 'rgba(255,255,255,0)' },
          ]),
        },
        // 两条线尾值接近时标签会重叠，交给 ECharts 做上下避让
        labelLayout: { moveOverlap: 'shiftY' },
        endLabel: {
          show: showEndLabel,
          color: color,
          fontSize: 11,
          formatter: function (p) {
            return p.value.toFixed(1);
          },
        },
        emphasis: { focus: 'series' },
        data: data,
        markLine: withBase
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#c9ced8', type: 'dashed', width: 1 },
              label: { show: false },
              data: [{ yAxis: 100 }],
            }
          : undefined,
      };
    }

    inst.setOption(
      {
        animationDuration: 420,
        grid: { left: 50, right: 44, top: 34, bottom: 30 },
        tooltip: Object.assign({}, TOOLTIP_BASE, {
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: '#c8cdd6', type: 'dashed' } },
          formatter: function (params) {
            var head = '<b>' + monthLabel(range[params[0].dataIndex].month) + '</b>';
            var lines = params.map(function (p) {
              var v = p.value;
              var chg = Math.round((v - 100) * 100) / 100;
              return (
                p.marker + p.seriesName + '　<b>' + v.toFixed(2) + '</b>　较基期 ' + fmtPct(chg)
              );
            });
            return head + '<br/>' + lines.join('<br/>');
          },
        }),
        legend: {
          top: 0,
          left: 0,
          itemWidth: 12,
          itemHeight: 3,
          itemGap: 16,
          textStyle: { color: '#48505e', fontSize: 11 },
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: months,
          axisLine: { lineStyle: { color: '#e3e6ec' } },
          axisTick: { show: false },
          axisLabel: AXIS_LABEL,
        },
        yAxis: {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: SPLIT_LINE,
          axisLabel: Object.assign({}, AXIS_LABEL, {
            formatter: function (v) {
              return Number(v).toFixed(1);
            },
          }),
        },
        series: [
          series('新建商品住宅', newData, ACCENT, true),
          series('二手住宅', secData, SECOND, false),
        ],
      },
      true
    );
  }

  // ------------------------------------------------------------ 明细表

  var COLUMNS = ['newMom', 'newYoy', 'secondMom', 'secondYoy'];

  function tableRows() {
    var p = latest();
    var rows = state.cities.map(function (c) {
      return {
        city: c,
        tier: state.tierOf[c],
        newMom: pct(p, 'new', c, 'mom'),
        newYoy: pct(p, 'new', c, 'yoy'),
        secondMom: pct(p, 'second', c, 'mom'),
        secondYoy: pct(p, 'second', c, 'yoy'),
      };
    });

    var key = state.sort.key;
    var dir = state.sort.dir;
    rows.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      if (key === 'city') return av < bv ? -dir : av > bv ? dir : 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
    return rows;
  }

  function renderTable() {
    var rows = tableRows();
    var key = state.sort.key;
    var dir = state.sort.dir;
    var tbody = $('dataTable').querySelector('tbody');

    var html = rows
      .map(function (r) {
        var cells = COLUMNS.map(function (k) {
          return '<td class="num ' + valClass(r[k]) + '">' + fmtPct(r[k]) + '</td>';
        }).join('');
        return (
          '<tr data-city="' + r.city + '"' + (r.city === state.focus ? ' class="is-focus"' : '') + '>' +
          '<td class="city">' + r.city + '</td>' +
          '<td><span class="tier-tag ' + TIER_CLASS[r.tier] + '">' + TIER_LABEL[r.tier] + '</span></td>' +
          cells +
          '</tr>'
        );
      })
      .join('');
    tbody.innerHTML = html;

    // 表头排序状态
    var ths = $('dataTable').querySelectorAll('th');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      if (th.getAttribute('data-key') === key) {
        th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    }

    // 点击行 → 聚焦该城市
    tbody.onclick = function (e) {
      var tr = e.target.closest ? e.target.closest('tr') : null;
      if (!tr) return;
      var city = tr.getAttribute('data-city');
      if (!city || city === state.focus) return;
      state.focus = city;
      $('citySelect').value = city;
      syncQuery();
      renderStampSubs();
      renderCityDetail();
      renderTable();
    };
  }

  /* ------------------------------------------------------------ 导出 CSV */

  /**
   * 两张表：当前展示月的 70 城全量对照 + 当前类型/口径的 城市 × 月份矩阵。
   * 矩阵是页面热力图的数据源，导出后可以直接在 Excel 里做透视，不用自己数格子。
   */
  function buildCsv() {
    if (!state.view.length) {
      window.alert('当前区间还没有数据可导出。');
      return;
    }
    var first = state.view[0].month;
    var last = state.view[state.view.length - 1].month;

    var detail = tableRows().map(function (r) {
      return {
        city: r.city,
        tier: TIER_LABEL[r.tier] || '',
        newMom: r.newMom === null ? '' : r.newMom,
        newYoy: r.newYoy === null ? '' : r.newYoy,
        secondMom: r.secondMom === null ? '' : r.secondMom,
        secondYoy: r.secondYoy === null ? '' : r.secondYoy,
      };
    });

    var matrixCols = [
      { key: 'city', label: '城市' },
      { key: 'tier', label: '分类' },
    ].concat(
      state.view.map(function (p) {
        return { key: p.month, label: p.month };
      })
    );
    var matrix = state.cities.map(function (city) {
      var row = { city: city, tier: TIER_LABEL[state.tierOf[city]] || '' };
      state.view.forEach(function (p) {
        var v = pct(p, state.type, city, state.metric);
        row[p.month] = v === null ? '' : v;
      });
      return row;
    });

    Board.csv(
      {
        file: 'housing',
        fileSuffix: first + '_' + last,
        module: '70 个大中城市房价指数看板',
        source: '国家统计局《70 个大中城市商品住宅销售价格变动情况》',
        interface: '/api/nbs70',
        range: monthLabel(first) + ' ~ ' + monthLabel(last),
        note: [
          '指数是价格「变动幅度」，不是成交均价；表中涨跌幅 = 指数 − 100（本页计算）',
          '「明细」为当前展示月（' + monthLabel(last) + '）的 70 城全量，排序与页面表格一致',
          '「矩阵」为页面当前选择的 ' + TYPE_LABEL[state.type] + ' · ' + METRIC_LABEL[state.metric] + '，空缺为该期未发布',
        ],
      },
      [
        {
          title: '明细：' + monthLabel(last) + ' 70 城对照',
          columns: [
            { key: 'city', label: '城市' },
            { key: 'tier', label: '分类' },
            { key: 'newMom', label: '新房环比', unit: '%', calc: true },
            { key: 'newYoy', label: '新房同比', unit: '%', calc: true },
            { key: 'secondMom', label: '二手环比', unit: '%', calc: true },
            { key: 'secondYoy', label: '二手同比', unit: '%', calc: true },
          ],
          rows: detail,
        },
        { title: '矩阵：' + TYPE_LABEL[state.type] + ' · ' + METRIC_LABEL[state.metric] + '（%）', columns: matrixCols, rows: matrix },
      ]
    );
  }

  Board.onExport($('exportBtn'), buildCsv);

  function bindTableSort() {
    var ths = $('dataTable').querySelectorAll('th.sortable');
    for (var i = 0; i < ths.length; i++) {
      ths[i].addEventListener('click', function () {
        var key = this.getAttribute('data-key');
        if (state.sort.key === key) state.sort.dir = -state.sort.dir;
        else state.sort = { key: key, dir: key === 'city' || key === 'tier' ? 1 : -1 };
        renderTable();
      });
    }
  }

  // ------------------------------------------------------------ 事件绑定

  function bindSeg(id, field) {
    var box = $(id);
    box.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seg-item') : null;
      if (!btn) return;
      var val = btn.getAttribute('data-value');
      if (state[field] === val) return;
      state[field] = val;
      var items = box.querySelectorAll('.seg-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-active', items[i] === btn);
      }
      renderAll();
    });
  }

  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      Object.keys(charts).forEach(function (k) {
        if (charts[k]) charts[k].resize();
      });
    }, 120);
  }

  function init() {
    bindSeg('segType', 'type');
    bindSeg('segMetric', 'metric');
    bindTableSort();

    $('citySelect').addEventListener('change', function () {
      state.focus = this.value;
      syncQuery();
      renderStampSubs();
      renderCityDetail();
      renderTable();
    });

    // 定基指数：城市 / 起点 / 终点
    $('baseCity').addEventListener('change', function () {
      state.base.city = this.value;
      renderBaseIndex();
    });
    $('baseStart').addEventListener('change', function () {
      state.base.startMonth = this.value;
      if (state.base.startMonth > state.base.endMonth) {
        state.base.endMonth = state.base.startMonth;
      }
      $('baseEnd').value = state.base.endMonth;
      renderBaseIndex();
    });
    $('baseEnd').addEventListener('change', function () {
      state.base.endMonth = this.value;
      if (state.base.endMonth < state.base.startMonth) {
        state.base.startMonth = state.base.endMonth;
      }
      $('baseStart').value = state.base.startMonth;
      renderBaseIndex();
    });

    // 时间范围：只在本地切视图，不会触发重新抓取
    $('rangeSelect').addEventListener('change', function () {
      state.range.preset = this.value;
      if (state.range.preset === 'custom') {
        var ps = state.periods;
        if (monthIndex(ps, state.range.from) < 0) state.range.from = ps.length ? ps[0].month : '';
        if (monthIndex(ps, state.range.to) < 0) {
          state.range.to = ps.length ? ps[ps.length - 1].month : '';
        }
      }
      saveRange();
      applyRange();
      renderAll();
    });
    $('rangeFrom').addEventListener('change', function () {
      state.range.from = this.value;
      if (state.range.from > state.range.to) state.range.to = state.range.from;
      saveRange();
      applyRange();
      renderAll();
    });
    $('rangeTo').addEventListener('change', function () {
      state.range.to = this.value;
      if (state.range.to < state.range.from) state.range.from = state.range.to;
      saveRange();
      applyRange();
      renderAll();
    });

    $('refreshBtn').addEventListener('click', function () {
      load(true);
    });

    window.addEventListener('resize', onResize);
    load(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
