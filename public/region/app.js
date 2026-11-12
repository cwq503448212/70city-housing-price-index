'use strict';

/**
 * 中国区域经济看板 · 分省 GDP —— 前端渲染
 *
 * 数据只发一次请求：GET /api/region?range=...
 * 31 个省 × 22 项指标的年度序列一次取回，年份与省份的切换全在前端完成，不再回源。
 *
 * 口径铁律（与页面「口径说明」一致，改前端别改口径）：
 *   - 不出现「全国」「合计」聚合值：各地区 GDP 相加不等于全国 GDP，本页任何位置都不做加总；
 *   - GDP、人均 GDP、三次产业增加值、分行业增加值、官方指数都是上游原值（当年价 / 上年=100）；
 *   - 三次产业占比、名义增速是本页计算值，图注标「本页计算」，不落盘；
 *   - 实际增速只取官方「地区生产总值指数」，图上按「指数 − 100」展示，不用 CPI 折算；
 *   - 分行业增加值与分产业指数随《中国统计年鉴》入库，比 GDP 晚一年（config 里的 lagYears），不算缺失；
 *   - 缺失就是缺失，画成空点，不补 0、不插值。
 */

(function () {
  const API = '/api/region';

  // 用户偏好存本地：改默认值时必须同时升级键名（v1 -> v2）
  const PREF = {
    range: 'region.range.v1',
    metric: 'region.metric.v1',
    province: 'region.province.v1',
  };
  const DEFAULTS = { range: 'all', metric: 'gdp', province: '440000000000' };

  // 排行可切换的指标：id 必须存在于 config/region.json；inputIndex 只对「指数 − 100」成立的指标生效
  const METRICS = [
    { id: 'gdp', label: 'GDP 总量', unit: '亿元', decimals: 1 },
    { id: 'gdp_yoy', label: '名义增速（本页算）', unit: '%', decimals: 1, computed: true },
    { id: 'gdp_index', label: '实际增速（官方）', unit: '%', decimals: 1, offset: 100 },
    { id: 'gdp_tertiary_share', label: '三产占比（本页算）', unit: '%', decimals: 1, computed: true },
  ];

  const COLOR = {
    ink: '#16181d',
    ink2: '#48505e',
    muted: '#7b8391',
    line: '#e8eaee',
    lineStrong: '#d9dce2',
    accent: '#175cd3',
    accentLight: '#5b8def',
    accentSoft: '#cfe0ff',
    pale: '#c6d4e6',
    primary: '#175cd3',
    secondary: '#b45309',
    tertiary: '#0e7490',
    rose: '#be123c',
    up: '#d14343',
    down: '#1f9254',
    flat: '#98a1ae',
  };

  const state = {
    range: DEFAULTS.range,
    metric: DEFAULTS.metric,
    province: DEFAULTS.province,
    year: '',
    data: null,
    loading: false,
    charts: {},
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    year: $('year'),
    range: $('range'),
    exportBtn: $('export-csv'),
    refresh: $('refresh'),
    status: $('status'),
    rangeHint: $('range-hint'),
    kpiRow: $('kpi-row'),
    chips: $('chips'),
    rankMetric: $('rank-metric'),
    rankTag: $('rank-tag'),
    rankSub: $('rank-sub'),
    industryTag: $('industry-tag'),
    srcLink: $('srcLink'),
  };

  const CHART_IDS = ['chart-rank', 'chart-trend', 'chart-industry', 'chart-percapita'];

  /* ---------------- 本地偏好 ---------------- */

  function loadPref() {
    // 地址栏优先：别人发来的链接要打开成他看到的那一屏
    const qsRange = Board.qs('range');
    if (['10', '20', 'all'].indexOf(qsRange) >= 0) state.range = qsRange;
    const qsMetric = Board.qs('metric');
    if (METRICS.some((m) => m.id === qsMetric)) state.metric = qsMetric;
    const qsProvince = Board.qs('province');
    if (/^\d{12}$/.test(qsProvince || '')) state.province = qsProvince;
    const qsYear = Board.qs('year');
    if (/^\d{4}$/.test(qsYear || '')) state.year = qsYear;
    if (qsRange || qsMetric || qsProvince) return; // 链接已给出视图，不再被本地偏好覆盖

    try {
      const range = localStorage.getItem(PREF.range);
      // 只认页面上真的存在的选项：旧版本残留的键值不把请求打到不存在的区间
      const okRange = Array.prototype.some.call(el.range.options, (opt) => opt.value === range);
      if (okRange) state.range = range;
      const metric = localStorage.getItem(PREF.metric);
      if (METRICS.some((m) => m.id === metric)) state.metric = metric;
      const province = localStorage.getItem(PREF.province);
      if (/^\d{12}$/.test(province || '')) state.province = province;
    } catch (e) {
      // 本地存的东西坏了就当没有
    }
  }

  function savePref() {
    try {
      localStorage.setItem(PREF.range, state.range);
      localStorage.setItem(PREF.metric, state.metric);
      localStorage.setItem(PREF.province, state.province);
    } catch (e) {
      // 隐私模式下写不了，不影响使用
    }
  }

  /** 视图写回地址栏（不刷新、不新增历史）：区间、指标、选中省、年份都能分享 */
  function syncQuery() {
    Board.setQs({
      range: state.range,
      metric: state.metric,
      province: state.province,
      year: state.year,
    });
  }

  /* ---------------- 数值格式 ---------------- */

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

  function yearCn(y) {
    return y ? y + ' 年' : '—';
  }

  /* ---------------- 数据访问 ---------------- */

  function provOf(code) {
    if (!state.data) return null;
    return state.data.provinces.filter((p) => p.code === code)[0] || null;
  }

  function shortOf(code) {
    const p = provOf(code);
    return p ? p.short || p.name : code;
  }

  function indicatorOf(id) {
    if (!state.data) return null;
    return state.data.indicators.filter((x) => x.id === id)[0] || null;
  }

  function decimalsOf(id) {
    const ind = indicatorOf(id);
    return ind && typeof ind.decimals === 'number' ? ind.decimals : 1;
  }

  /** 缓存里某省某指标某年的原值；缺失一律 null */
  function valueAt(code, id, year) {
    if (!state.data || !state.data.data[code]) return null;
    const m = state.data.data[code][id];
    if (!m) return null;
    const v = m[year];
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /** 指标在所有省里出现过的年度，升序 */
  function yearsUnion(id) {
    if (!state.data) return [];
    const set = new Set();
    state.data.provinces.forEach((p) => {
      const per = state.data.data[p.code];
      const m = per && per[id];
      if (m) Object.keys(m).forEach((y) => set.add(y));
    });
    return Array.from(set).sort();
  }

  /** 请求区间内的连续年度轴：用来暴露断点，而不是把缺口挤掉 */
  function spanYears() {
    if (!state.data) return [];
    const from = Number(state.data.range.from);
    const to = Number(state.data.range.to);
    const out = [];
    for (let y = from; y <= to; y += 1) out.push(String(y));
    return out;
  }

  /** 横截面：某指标某年的全部省份，按值降序；缺值省份不参与（不补 0） */
  function crossSection(id, year, offset) {
    if (!state.data) return [];
    const rows = [];
    state.data.provinces.forEach((p) => {
      const raw = valueAt(p.code, id, year);
      if (raw === null) return;
      rows.push({
        code: p.code,
        name: p.name,
        short: p.short || p.name,
        value: offset ? raw - offset : raw,
      });
    });
    rows.sort((a, b) => b.value - a.value);
    // 同值并列：跟 /api/region/rank 一样按值并列，不拿数组下标硬排一个先后
    rows.forEach((row, i) => {
      row.rank = i > 0 && row.value === rows[i - 1].value ? rows[i - 1].rank : i + 1;
    });
    return rows;
  }

  function rankOf(rows, code) {
    const hit = rows.filter((r) => r.code === code)[0];
    return hit ? hit.rank : 0;
  }

  /** 展示值：指数类指标减 100 才是「增速 %」 */
  function showOf(metric, code, year) {
    const raw = valueAt(code, metric.id, year);
    if (raw === null) return null;
    return metric.offset ? raw - metric.offset : raw;
  }

  function metricOf(id) {
    return METRICS.filter((m) => m.id === id)[0] || METRICS[0];
  }

  /* ---------------- 图表基座 ---------------- */

  function chartOf(id) {
    const dom = document.getElementById(id);
    if (!dom || typeof echarts === 'undefined') return null;
    if (!state.charts[id]) state.charts[id] = echarts.init(dom, null, { renderer: 'canvas' });
    return state.charts[id];
  }

  function axisLabel(fmt) {
    return { color: COLOR.muted, fontSize: 11, formatter: fmt || ((v) => fmtNum(v, 0)) };
  }

  function valueAxis(fmt) {
    return {
      type: 'value',
      scale: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: axisLabel(fmt),
      splitLine: { lineStyle: { color: COLOR.line } },
    };
  }

  function categoryAxis(data, extra) {
    return Object.assign(
      {
        type: 'category',
        data: data,
        axisLine: { lineStyle: { color: COLOR.lineStrong } },
        axisTick: { show: false },
        axisLabel: { color: COLOR.muted, fontSize: 11, hideOverlap: true },
      },
      extra || {}
    );
  }

  function tooltipBox(trigger) {
    return {
      trigger: trigger || 'axis',
      backgroundColor: 'rgba(22,24,29,0.92)',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      padding: [8, 10],
      axisPointer: { type: trigger === 'item' ? 'shadow' : 'line', lineStyle: { color: COLOR.lineStrong } },
    };
  }

  function emptyChart(id, text) {
    const chart = chartOf(id);
    if (!chart) return;
    chart.clear();
    chart.setOption({
      graphic: [{ type: 'text', left: 'center', top: 'middle', style: { text: text, fill: COLOR.muted, fontSize: 13 } }],
    });
  }

  function apply(id, option) {
    const chart = chartOf(id);
    if (!chart) return;
    chart.setOption(option, true);
  }

  /* ---------------- 横向条形（排行 / 人均） ---------------- */

  /**
   * 31 个省画在一根轴上：值降序，最高的一根在最上面。
   * rows 已按值降序，ECharts 的类目轴自下而上排，所以倒序喂进去。
   */
  function hBarOption(rows, opts) {
    const o = opts || {};
    const cats = rows.map((x) => x.short);
    const values = rows.map((x) => x.value);
    const selected = state.province;
    const dec = typeof o.decimals === 'number' ? o.decimals : 1;
    const tipValue = (v) => (o.signed ? fmtSigned(v, dec) : fmtNum(v, dec)) + (o.unit ? ' ' + o.unit : '');

    return {
      animationDuration: 420,
      grid: { left: 8, right: 74, top: 8, bottom: 24, containLabel: true },
      tooltip: Object.assign(tooltipBox('item'), {
        formatter: (p) => {
          const i = rows.length - 1 - p.dataIndex;
          const row = rows[i];
          if (!row) return '';
          return (
            esc(row.name) +
            '　第 ' +
            (row.rank || i + 1) +
            ' 位<br/>' +
            esc(o.metricLabel || '') +
            '　' +
            tipValue(p.value)
          );
        },
      }),
      xAxis: Object.assign(valueAxis(o.axisFormat), { min: o.min }),
      yAxis: Object.assign(categoryAxis(cats.slice().reverse()), {
        axisLabel: {
          color: COLOR.muted,
          fontSize: 11,
          interval: 0,
          formatter: (name) => name,
        },
      }),
      series: [
        {
          type: 'bar',
          barMaxWidth: 14,
          data: values
            .slice()
            .reverse()
            .map((v, i) => {
              const row = rows[rows.length - 1 - i];
              const isSelf = row.code === selected;
              let color = COLOR.pale;
              if (o.signed) color = v >= 0 ? COLOR.up : COLOR.down;
              if (isSelf) color = COLOR.accent;
              return {
                value: v,
                itemStyle: { color: color, borderRadius: [0, 3, 3, 0] },
                // 工具提示用不到 data item 的自定义字段，这里挂上省份名方便回调取
                name: row.name,
              };
            }),
          label: {
            show: true,
            position: 'right',
            fontSize: 11,
            color: COLOR.ink2,
            formatter: (p) => (o.labelFormat ? o.labelFormat(p.value) : fmtNum(p.value, 0)),
          },
          emphasis: { itemStyle: { borderColor: COLOR.accent, borderWidth: 1 } },
        },
      ],
    };
  }

  /* ---------------- 图 1：省份排行 ---------------- */

  let rankRows = [];

  function renderRank() {
    const metric = metricOf(state.metric);
    const rows = crossSection(metric.id, state.year, metric.offset);
    rankRows = rows;

    if (!rows.length) {
      el.rankTag.textContent = '';
      emptyChart('chart-rank', '该年暂无数据');
      return;
    }

    const computed = !!metric.computed;
    el.rankTag.textContent = yearCn(state.year) + (computed ? '　本页计算' : '');
    el.rankTag.className = 'tag ' + (computed ? 'info' : '');

    const missing = state.data.provinces.length - rows.length;
    el.rankSub.textContent =
      '31 个省级行政区按「' +
      metric.label +
      '」降序；' +
      (missing > 0 ? missing + ' 个省份该年缺数，不参与排序（不补 0）。' : '全部 31 个省份均有该年数据。') +
      '点击条形切换下方单省视图';

    const isLevel = metric.id === 'gdp';
    const option = hBarOption(rows, {
      // 增速类按正负上色（红涨绿跌），总量类统一浅色，选中省始终用主色
      signed: metric.id === 'gdp_yoy' || metric.id === 'gdp_index',
      metricLabel: metric.label,
      unit: metric.unit,
      decimals: 1,
      labelFormat: (v) => (metric.unit === '%' ? fmtSigned(v, 1) + '%' : fmtNum(v, isLevel ? 0 : 1)),
      axisFormat: (v) => (metric.unit === '%' ? fmtNum(v, 0) + '%' : fmtNum(v, 0)),
    });
    apply('chart-rank', option);

    const chart = chartOf('chart-rank');
    if (chart) {
      chart.off('click');
      chart.on('click', (p) => {
        // 条形是倒序喂进去的，取回原始行
        const row = rankRows[rankRows.length - 1 - p.dataIndex];
        if (row && row.code !== state.province) selectProvince(row.code);
      });
    }
  }

  /* ---------------- 图 2：单省走势 ---------------- */

  function renderTrend() {
    const code = state.province;
    const years = spanYears();
    const gdp = years.map((y) => valueAt(code, 'gdp', y));
    const idx = years.map((y) => {
      const raw = valueAt(code, 'gdp_index', y);
      return raw === null ? null : Math.round((raw - 100) * 10) / 10;
    });

    if (!gdp.some((v) => v !== null)) {
      emptyChart('chart-trend', shortOf(code) + ' 暂无数据');
      return;
    }

    const option = {
      animationDuration: 420,
      grid: { left: 8, right: 8, top: 44, bottom: 26, containLabel: true },
      tooltip: Object.assign(tooltipBox('axis'), {
        formatter: (params) => {
          if (!params || !params.length) return '';
          const y = years[params[0].dataIndex];
          const head = esc(yearCn(y) + '　' + shortOf(code));
          const rows = params.map((p) => {
            if (p.value === null || p.value === undefined) return p.marker + ' ' + esc(p.seriesName) + '　—';
            if (p.seriesName === '实际增速') return p.marker + ' 实际增速　' + fmtSigned(p.value, 1) + '%';
            return p.marker + ' 地区生产总值　' + fmtNum(p.value, 1) + ' 亿元';
          });
          const raw = valueAt(code, 'gdp_index', y);
          if (raw !== null) {
            rows.push('<span style="opacity:.72">官方指数 ' + fmtNum(raw, 1) + '（上年=100）</span>');
          }
          return head + '<br/>' + rows.join('<br/>');
        },
      }),
      legend: {
        top: 0,
        left: 0,
        right: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: COLOR.muted, fontSize: 12 },
      },
      xAxis: categoryAxis(years),
      yAxis: [
        Object.assign(valueAxis((v) => fmtNum(v, 0)), { name: '亿元', nameTextStyle: { color: COLOR.muted, fontSize: 11 } }),
        {
          type: 'value',
          position: 'right',
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: COLOR.muted, fontSize: 11, formatter: (v) => fmtNum(v, 0) + '%' },
          splitLine: { show: false },
          name: '实际增速',
          nameTextStyle: { color: COLOR.muted, fontSize: 11 },
        },
      ],
      series: [
        {
          name: '地区生产总值',
          type: 'bar',
          data: gdp,
          barMaxWidth: 20,
          itemStyle: { color: COLOR.accentSoft, borderRadius: [3, 3, 0, 0] },
          emphasis: { itemStyle: { color: COLOR.accentLight } },
        },
        {
          name: '实际增速',
          type: 'line',
          yAxisIndex: 1,
          data: idx,
          smooth: 0.2,
          showSymbol: false,
          symbol: 'circle',
          symbolSize: 6,
          connectNulls: false,
          lineStyle: { width: 2, color: COLOR.rose },
          itemStyle: { color: COLOR.rose },
        },
      ],
    };
    apply('chart-trend', option);
  }

  /* ---------------- 图 3：三次产业构成 ---------------- */

  function renderIndustry() {
    const code = state.province;
    const years = spanYears();
    const first = years.map((y) => valueAt(code, 'gdp_primary_share', y));
    const second = years.map((y) => valueAt(code, 'gdp_secondary_share', y));
    const third = years.map((y) => valueAt(code, 'gdp_tertiary_share', y));

    // 缺任一分项就整条不画：不把两项凑成 100% 画出去
    const ok = years.map((y, i) => first[i] !== null && second[i] !== null && third[i] !== null);
    const a = first.map((v, i) => (ok[i] ? v : null));
    const b = second.map((v, i) => (ok[i] ? v : null));
    const c = third.map((v, i) => (ok[i] ? v : null));

    const at = years.indexOf(state.year);
    const label =
      at >= 0 && ok[at]
        ? shortOf(code) +
          ' · ' +
          yearCn(state.year) +
          '：一产 ' +
          fmtNum(a[at], 1) +
          '% / 二产 ' +
          fmtNum(b[at], 1) +
          '% / 三产 ' +
          fmtNum(c[at], 1) +
          '%'
        : shortOf(code) + ' · ' + yearCn(state.year) + '：该年三次产业数据不全';
    el.industryTag.textContent = label;

    if (!ok.some(Boolean)) {
      emptyChart('chart-industry', '暂无三次产业构成数据');
      return;
    }

    const option = {
      animationDuration: 420,
      grid: { left: 8, right: 8, top: 44, bottom: 24, containLabel: true },
      tooltip: Object.assign(tooltipBox('axis'), {
        formatter: (params) => {
          if (!params || !params.length) return '';
          const i = params[0].dataIndex;
          const head = esc(yearCn(years[i]) + '　' + shortOf(code));
          if (!ok[i]) return head + '<br/><span style="opacity:.72">该年数据不全，不画构成</span>';
          const rows = params.map(
            (p) => p.marker + ' ' + esc(p.seriesName) + '　' + fmtNum(p.value, 1) + '%'
          );
          rows.push('<span style="opacity:.72">本页计算值：该产业增加值 ÷ GDP × 100</span>');
          return head + '<br/>' + rows.join('<br/>');
        },
      }),
      legend: {
        top: 0,
        left: 0,
        right: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: COLOR.muted, fontSize: 12 },
      },
      xAxis: categoryAxis(years),
      yAxis: Object.assign(valueAxis((v) => fmtNum(v, 0) + '%'), { max: 100, min: 0 }),
      series: [
        {
          name: '第一产业',
          type: 'bar',
          stack: 'share',
          data: a,
          barMaxWidth: 20,
          itemStyle: { color: COLOR.secondary },
        },
        {
          name: '第二产业',
          type: 'bar',
          stack: 'share',
          data: b,
          barMaxWidth: 20,
          itemStyle: { color: COLOR.primary },
        },
        {
          name: '第三产业',
          type: 'bar',
          stack: 'share',
          data: c,
          barMaxWidth: 20,
          itemStyle: { color: COLOR.tertiary, borderRadius: [3, 3, 0, 0] },
        },
      ],
    };
    apply('chart-industry', option);
  }

  /* ---------------- 图 4：人均 GDP 对比 ---------------- */

  function renderPerCapita() {
    const rows = crossSection('gdp_per_capita', state.year);
    if (!rows.length) {
      emptyChart('chart-percapita', '该年暂无人均 GDP 数据');
      return;
    }
    const option = hBarOption(rows, {
      metricLabel: '人均地区生产总值',
      unit: '元/人',
      decimals: 0,
      labelFormat: (v) => fmtNum(v, 0),
      axisFormat: (v) => fmtNum(v, 0),
    });
    apply('chart-percapita', option);
  }

  /* ---------------- KPI（横截面统计，不做全国合计） ---------------- */

  function kpiCard(kpi) {
    return (
      '<article class="kpi">' +
      '<div class="kpi-label">' + kpi.label + '</div>' +
      '<div class="kpi-value ' + (kpi.cls || '') + '">' + kpi.value +
      (kpi.unit ? '<small>' + esc(kpi.unit) + '</small>' : '') +
      '</div>' +
      '<div class="kpi-foot">' + (kpi.foot || '') + '</div>' +
      '</article>'
    );
  }

  function renderKpi() {
    if (!state.data) return;
    const year = state.year;
    const code = state.province;
    const total = state.data.provinces.length;
    const short = esc(shortOf(code));

    const gdpRows = crossSection('gdp', year);
    const pcRows = crossSection('gdp_per_capita', year);
    const gdp = valueAt(code, 'gdp', year);
    const pc = valueAt(code, 'gdp_per_capita', year);
    const idx = valueAt(code, 'gdp_index', year);
    const yoy = valueAt(code, 'gdp_yoy', year);
    const p1 = valueAt(code, 'gdp_primary_share', year);
    const p2 = valueAt(code, 'gdp_secondary_share', year);
    const p3 = valueAt(code, 'gdp_tertiary_share', year);

    const gdpRank = gdp === null ? 0 : rankOf(gdpRows, code);
    const pcRank = pc === null ? 0 : rankOf(pcRows, code);

    const list = [];

    list.push({
      label: '<span>' + short + ' · 地区生产总值</span><span class="tag">' + esc(year) + '</span>',
      value: fmtNum(gdp, 1),
      unit: '亿元',
      foot:
        (gdpRank ? total + ' 省中第 <strong>' + gdpRank + '</strong> 位' : '该年缺数') +
        '　' +
        (yoy === null ? '名义增速 —' : '<span class="kpi-delta ' + signClass(yoy) + '">' + fmtSigned(yoy, 1) + '%</span> 名义（本页算）'),
    });

    list.push({
      label: '<span>' + short + ' · 人均地区生产总值</span><span class="tag">' + esc(year) + '</span>',
      value: fmtNum(pc, 0),
      unit: '元/人',
      foot: pcRank ? total + ' 省中第 <strong>' + pcRank + '</strong> 位　官方按年平均常住人口计算' : '该年缺数',
    });

    list.push({
      label: '<span>' + short + ' · 实际增速（官方）</span><span class="tag">' + esc(year) + '</span>',
      value: idx === null ? '—' : fmtSigned(idx - 100, 1),
      unit: '%',
      cls: idx === null ? 'flat' : signClass(idx - 100),
      foot: idx === null ? '该年缺数' : '官方指数 ' + fmtNum(idx, 1) + '（上年=100）',
    });

    list.push({
      label: '<span>' + short + ' · 名义增速</span><span class="tag info">本页计算</span>',
      value: yoy === null ? '—' : fmtSigned(yoy, 1),
      unit: '%',
      cls: yoy === null ? 'flat' : signClass(yoy),
      foot: '含价格因素，与上格的实际增速不是一回事',
    });

    list.push({
      label: '<span>' + short + ' · 三产占比</span><span class="tag info">本页计算</span>',
      value: p3 === null ? '—' : fmtNum(p3, 1),
      unit: '%',
      foot:
        p1 === null && p2 === null
          ? '该年缺数'
          : '一产 ' + fmtNum(p1, 1) + '%　二产 ' + fmtNum(p2, 1) + '%',
    });

    const top = gdpRows[0];
    const bottom = gdpRows[gdpRows.length - 1];
    list.push({
      label: '<span>省际极差</span><span class="tag">' + esc(year) + '</span>',
      value: top && bottom && bottom.value > 0 ? fmtNum(top.value / bottom.value, 1) : '—',
      unit: '倍',
      foot:
        top && bottom
          ? esc(top.short) + ' ' + fmtNum(top.value, 0) + ' ÷ ' + esc(bottom.short) + ' ' + fmtNum(bottom.value, 0) + '（亿元）'
          : '该年缺数',
    });

    el.kpiRow.innerHTML = list.map(kpiCard).join('');
  }

  /* ---------------- 省份 chip ---------------- */

  function renderChips() {
    if (!state.data) return;
    el.chips.replaceChildren();
    state.data.provinces.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (p.code === state.province ? ' is-active' : '');
      btn.textContent = p.short || p.name;
      btn.title = p.name;
      btn.addEventListener('click', () => {
        if (p.code !== state.province) selectProvince(p.code);
      });
      el.chips.appendChild(btn);
    });
  }

  function syncChips() {
    Array.prototype.forEach.call(el.chips.children, (btn) => {
      const p = state.data.provinces.filter((x) => (x.short || x.name) === btn.textContent)[0];
      if (!p) return;
      btn.className = 'chip' + (p.code === state.province ? ' is-active' : '');
    });
  }

  function selectProvince(code) {
    state.province = code;
    savePref();
    syncQuery();
    syncChips();
    renderKpi();
    renderRank();
    renderTrend();
    renderIndustry();
    renderPerCapita();
  }

  /* ---------------- 年份 / 指标切换 ---------------- */

  function countAt(id, year) {
    if (!state.data) return 0;
    return state.data.provinces.filter((p) => valueAt(p.code, id, year) !== null).length;
  }

  /** 默认年份：最新的「多数省份都已公布」的那一年，避免只落地一两个省就切过去 */
  function defaultYear() {
    const years = yearsUnion('gdp');
    for (let i = years.length - 1; i >= 0; i -= 1) {
      if (countAt('gdp', years[i]) >= 24) return years[i];
    }
    return years.length ? years[years.length - 1] : '';
  }

  function buildYearSelect() {
    const years = yearsUnion('gdp');
    el.year.replaceChildren();
    years
      .slice()
      .reverse()
      .forEach((y) => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y + ' 年';
        el.year.appendChild(opt);
      });

    const keep = years.indexOf(state.year) >= 0 ? state.year : '';
    state.year = keep || defaultYear();
    el.year.value = state.year;
    // 年份已定下来（可能会被兜底成默认年）后再写回地址栏
    syncQuery();
  }

  function renderMetricSeg() {
    if (!el.rankMetric.children.length) {
      METRICS.forEach((m) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.metric = m.id;
        btn.textContent = m.label;
        btn.addEventListener('click', () => {
          if (m.id === state.metric) return;
          state.metric = m.id;
          savePref();
          syncQuery();
          syncMetricSeg();
          renderRank();
        });
        el.rankMetric.appendChild(btn);
      });
    }
    syncMetricSeg();
  }

  function syncMetricSeg() {
    Array.prototype.forEach.call(el.rankMetric.children, (btn) => {
      btn.className = btn.dataset.metric === state.metric ? 'is-active' : '';
    });
  }

  el.year.addEventListener('change', () => {
    // 选项还没就绪（或被人为置空）时 value 会是空串，这时不能拿空年份去重画，否则整页变成「该年缺数」
    if (!/^\d{4}$/.test(el.year.value)) return;
    state.year = el.year.value;
    syncQuery();
    renderKpi();
    renderRank();
    renderIndustry();
    renderPerCapita();
  });

  el.range.addEventListener('change', () => {
    state.range = el.range.value;
    savePref();
    syncQuery();
    load(false);
  });

  el.refresh.addEventListener('click', () => load(true));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      Object.keys(state.charts).forEach((k) => state.charts[k].resize());
    }, 120);
  });

  /* ---------------- 状态栏 ---------------- */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    if (kind !== 'error') el.status.title = '';
  }

  let slowTimer = null;

  function hintSlow() {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      setStatus('首次打开要逐省拉取 31 次（约 40 秒），期间页面会保持等待…');
    }, 4000);
  }

  function clearHint() {
    clearTimeout(slowTimer);
  }

  /** 状态只看服务端给的 stale / errors / expectedYear，不自己猜年份 */
  function applyStatus(json) {
    const staleList = json.indicators.filter((x) => x.stale);
    const busy = json.refreshing ? '（后台补齐中…）' : '';

    if (json.errors && json.errors.length) {
      setStatus('上游异常，已回退本地缓存（' + staleList.length + ' 项待更新）' + busy, 'warn');
      el.status.title = json.errors.join('\n');
      return;
    }
    if (!staleList.length) {
      const first = json.firstRun ? '　首次运行已写入缓存' : '';
      setStatus(
        '数据完整　' +
          (json.cache.provinces || 0) +
          '/31 省　最新年度 ' +
          (json.latestYear || '—') +
          '（应发布 ' +
          (json.expectedYear || '—') +
          '）' +
          (json.fetched ? '　本次回源 ' + json.fetched + ' 个省·栏目' : '　全部命中本地缓存') +
          busy +
          first,
        'ok'
      );
      return;
    }
    // 分行业增加值随年鉴入库会晚一年，这里按「最新年度」说人话，不说「数据过期」；
    // 另有「某个省整条没数据」的情况，那种不说年份，直接说省份不齐
    const parts = [];
    const withYear = staleList.filter((x) => x.latestCached);
    if (withYear.length) {
      const years = withYear.map((x) => x.latestCached).sort();
      const oldest = years[0];
      const newest = years[years.length - 1];
      parts.push(
        withYear.length +
          ' 项最新为 ' +
          (oldest === newest ? oldest : oldest + '—' + newest) +
          ' 年（应发布 ' +
          (json.expectedYear || '—') +
          '，尚未入库）'
      );
    }
    if (staleList.length > withYear.length) {
      parts.push(staleList.length - withYear.length + ' 项有省份缺数');
    }
    setStatus('已有 ' + (json.latestYear || '—') + ' 年数据　' + parts.join('；') + busy, 'warn');
  }

  function renderHint() {
    const d = state.data;
    if (!d) return;
    el.rangeHint.textContent =
      '当前区间：' +
      yearCn(d.range.from) +
      ' ~ ' +
      yearCn(d.range.to) +
      '　' +
      (d.rangeLabel || d.range.label) +
      '　' +
      d.provinces.length +
      ' 个省级行政区 × ' +
      d.indicators.length +
      ' 项指标（不含港澳台，不做全国合计）　最新年度 ' +
      (d.latestYear || '—') +
      '，应发布到 ' +
      d.expectedYear +
      '（GDP 于次年 1 月公布，行业增加值随《中国统计年鉴》滞后一年）';
    if (d.source && d.source.url && el.srcLink) el.srcLink.href = d.source.url;
  }

  /* ---------------- 数据加载 ---------------- */

  function queryString(force) {
    const q = ['range=' + encodeURIComponent(state.range)];
    if (force) q.push('force=1');
    return q.join('&');
  }

  async function fetchData(force) {
    const res = await fetch(API + '?' + queryString(force), { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status);
    return json;
  }

  function renderAll() {
    renderKpi();
    renderChips();
    renderRank();
    renderTrend();
    renderIndustry();
    renderPerCapita();
    renderHint();
  }

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    el.range.disabled = true;
    clearTimeout(pollTimer);
    pollCount = 0;
    setStatus(force ? '正在重新向统计局核对…' : '正在读取数据…');
    hintSlow();

    try {
      const json = await fetchData(force);
      state.data = json;
      renderMetricSeg();
      buildYearSelect();
      renderAll();
      applyStatus(json);
      schedulePoll(json);
    } catch (e) {
      setStatus('加载失败：' + (e.message || e), 'error');
      if (!state.data) CHART_IDS.forEach((id) => emptyChart(id, '加载失败'));
    } finally {
      clearHint();
      state.loading = false;
      el.refresh.disabled = false;
      el.range.disabled = false;
    }
  }

  /* ---------------- 后台补齐轮询 ---------------- */

  // 首屏只同步拉 GDP 栏目，官方指数在后台补；这里自己再取一次把新数据换上去。
  // 31 个省 × 1 个栏目约 40 秒，4 秒一次、最多 25 次（约 100 秒），不无限轮询。
  let pollTimer = null;
  let pollCount = 0;

  function schedulePoll(json) {
    if (!json || !json.refreshing) {
      pollCount = 0;
      return;
    }
    if (pollCount >= 25) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, 4000);
  }

  async function pollOnce() {
    if (state.loading) return; // 用户正在操作，这次就不插队了
    pollCount += 1;
    try {
      const res = await fetch(API + '?' + queryString(false), { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const json = await res.json();
      state.data = json;
      buildYearSelect();
      renderAll();
      applyStatus(json);
      schedulePoll(json);
    } catch (e) {
      // 轮询失败不打扰用户，下次操作会重新取数
    }
  }

  function buildCsv() {
    if (!state.data) {
      window.alert('数据还没加载完成，稍后再导出。');
      return;
    }
    const metric = metricOf(state.metric);
    const year = state.year;
    const rows = crossSection(metric.id, year, metric.offset);
    const blocks = [];

    // 一块：选中年份的省份横截面（全部四项指标 + 当前指标排名）
    const snapCols = [
      { key: 'code', label: '行政区划代码' },
      { key: 'name', label: '省份' },
      { key: 'gdp', label: '地区生产总值', unit: '亿元' },
      { key: 'gdp_yoy', label: '名义增速', unit: '%', calc: true },
      { key: 'gdp_index', label: '实际增速（官方指数−100）', unit: '%' },
      { key: 'gdp_tertiary_share', label: '第三产业占 GDP 比重', unit: '%', calc: true },
      { key: 'gdp_per_capita', label: '人均地区生产总值', unit: '元/人' },
      { key: 'rank', label: '排名（' + metric.label + '）' },
    ];
    const snapRows = state.data.provinces.map((p) => {
      const raw = valueAt(p.code, 'gdp_index', year);
      return {
        code: p.code,
        name: p.name,
        gdp: valueAt(p.code, 'gdp', year),
        gdp_yoy: valueAt(p.code, 'gdp_yoy', year),
        gdp_index: raw === null ? '' : raw - 100,
        gdp_tertiary_share: valueAt(p.code, 'gdp_tertiary_share', year),
        gdp_per_capita: valueAt(p.code, 'gdp_per_capita', year),
        rank: rankOf(rows, p.code) || '',
      };
    });
    snapRows.forEach((r) => {
      Object.keys(r).forEach((k) => {
        if (r[k] === null) r[k] = '';
      });
    });
    blocks.push({ title: '省份横截面（' + year + ' 年）', columns: snapCols, rows: snapRows });

    // 二块：选中省在走势区间内的逐年序列
    const prov = provOf(state.province);
    const years = spanYears();
    const trendCols = [
      { key: 'year', label: '年份' },
      { key: 'gdp', label: '地区生产总值', unit: '亿元' },
      { key: 'gdp_yoy', label: '名义增速', unit: '%', calc: true },
      { key: 'gdp_primary', label: '第一产业增加值', unit: '亿元' },
      { key: 'gdp_secondary', label: '第二产业增加值', unit: '亿元' },
      { key: 'gdp_tertiary', label: '第三产业增加值', unit: '亿元' },
      { key: 'gdp_tertiary_share', label: '第三产业占 GDP 比重', unit: '%', calc: true },
      { key: 'gdp_index', label: '实际增速（官方指数−100）', unit: '%' },
      { key: 'gdp_per_capita', label: '人均地区生产总值', unit: '元/人' },
    ];
    const trendRows = years.map((y) => {
      const idx = valueAt(state.province, 'gdp_index', y);
      return {
        year: y,
        gdp: valueAt(state.province, 'gdp', y),
        gdp_yoy: valueAt(state.province, 'gdp_yoy', y),
        gdp_primary: valueAt(state.province, 'gdp_primary', y),
        gdp_secondary: valueAt(state.province, 'gdp_secondary', y),
        gdp_tertiary: valueAt(state.province, 'gdp_tertiary', y),
        gdp_tertiary_share: valueAt(state.province, 'gdp_tertiary_share', y),
        gdp_index: idx === null ? '' : idx - 100,
        gdp_per_capita: valueAt(state.province, 'gdp_per_capita', y),
      };
    });
    trendRows.forEach((r) => {
      Object.keys(r).forEach((k) => {
        if (r[k] === null) r[k] = '';
      });
    });
    blocks.push({
      title: '单省走势：' + (prov ? prov.name : state.province) + '（' + years[0] + ' ~ ' + years[years.length - 1] + '）',
      columns: trendCols,
      rows: trendRows,
    });

    Board.csv(
      {
        file: 'region',
        fileSuffix: year,
        module: '中国区域经济看板 · 分省 GDP',
        source: '国家统计局 · 国家数据（分省年度库 · 地区生产总值与官方指数）',
        interface: '/api/region',
        range: '横截面 ' + year + ' 年；走势 ' + years[0] + ' ~ ' + years[years.length - 1],
        note: [
          '只包含 31 个省级行政区，不含港澳台；分省 GDP 相加不等于全国总量，本页不提供全国聚合数',
          'GDP 与三次产业增加值为当年价名义值；实际增速 = 官方「地区生产总值指数（上年=100）」− 100',
          '名义增速与三次产业占比为列名带「本页计算」的列，均由本页相除 / 相减得到，不是官方发布值',
          '横截面只含选中年份有值的省份；走势区间内缺某年数据就是空格，不插值、不补 0',
          '分行业增加值与分产业指数通常比 GDP 滞后一年，最新年为空是正常的发布滞后',
        ],
      },
      blocks
    );
  }

  Board.onExport(el.exportBtn, buildCsv);

  /* ---------------- 启动 ---------------- */

  (async function boot() {
    loadPref();
    // 控件跟着恢复出来的偏好走：否则存了「近 10 年」再打开，下拉框还显示「全部」，
    // 而再选「全部」不会触发 change，用户没法直接回到全量
    el.range.value = state.range;
    setStatus('正在连接本地服务…');
    hintSlow();
    try {
      const json = await fetchData(false);
      state.data = json;
      renderMetricSeg();
      buildYearSelect();
      renderAll();
      applyStatus(json);
      schedulePoll(json);
    } catch (e) {
      setStatus('加载失败：' + (e.message || e) + '（确认本地服务已启动）', 'error');
      CHART_IDS.forEach((id) => emptyChart(id, '加载失败'));
    } finally {
      clearHint();
    }
  })();
})();
