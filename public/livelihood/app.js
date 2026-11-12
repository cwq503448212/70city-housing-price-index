'use strict';

/**
 * 中国人口与婚育看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/livelihood/overview?range=...
 * 顶部时间选择一变，整页（KPI + 9 张图 + 明细表）全部按新区间重画。
 * 前端不判断「哪一年该有数」——那是服务端 lib/livelihood/policy.js 的事，这里只消费 stale 字段。
 * 出生 / 死亡人口、自然增长量、生死比是服务端现算的计算值（computed），图上必须标清。
 */

(function () {
  // 8 张 KPI：出生 / 死亡排在首位（本页最想看的量），其余沿用原来的结构与婚姻指标
  const KPI_LIST = [
    { id: 'birth_count', label: '出生人口' },
    { id: 'death_count', label: '死亡人口' },
    { id: 'birth_rate', label: '人口出生率' },
    { id: 'natural_growth_rate', label: '人口自然增长率' },
    { id: 'pop_65', label: '65 岁以上人口' },
    { id: 'aged_dependency', label: '老年抚养比' },
    { id: 'marriage_reg', label: '结婚登记' },
    { id: 'divorce_reg', label: '离婚登记' },
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
    exportBtn: $('export-csv'),
  };

  /* ---------------- 本地偏好 ---------------- */

  function loadPref() {
    // 地址栏优先：?range=20 或 ?from=2000&to=2024
    const qsFrom = Board.qs('from');
    const qsTo = Board.qs('to');
    const qsRange = Board.qs('range');
    if (/^\d{4}$/.test(qsFrom || '') && /^\d{4}$/.test(qsTo || '')) {
      state.range = 'custom';
      state.from = qsFrom;
      state.to = qsTo;
      return;
    }
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

  /** 百分比（抚养比等）：与千分率一样不带空格，但差值用「个百分点」 */
  function isPercent(ind) {
    return ind.kind === 'percent';
  }

  function unitOf(ind) {
    if (isRate(ind)) return '‰';
    if (isPercent(ind)) return '%';
    return ind.unit;
  }

  /** 后缀：千分率 / 百分比紧跟数字，普通单位前留一个空格 */
  function unitSuffix(ind) {
    if (isRate(ind) || isPercent(ind)) return unitOf(ind);
    return ' ' + ind.unit;
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
    return body + unitSuffix(ind);
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

  /** 差值的量纲：千分率用「个千分点」，百分比用「个百分点」，其余沿用指标单位 */
  function deltaUnit(ind) {
    if (isRate(ind)) return ' 个千分点';
    if (isPercent(ind)) return ' 个百分点';
    return ' ' + ind.unit;
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

  /**
   * 出生人口 / 死亡人口：双柱 + 自然增长量折线
   * 三个序列全是服务端现算的计算值（年度库只发布千分率），不是官方发布值
   */
  function renderBirthDeath() {
    const years = yearsOf();
    if (!years.length || !byId('birth_count') || !byId('death_count')) {
      return emptyChart('chart-birthdeath', '暂无数据');
    }

    const births = seriesOf('birth_count');
    const deaths = seriesOf('death_count');
    const net = seriesOf('natural_growth_count');

    // 峰值 / 谷值只看出生人口；交叉年份 = 区间内第一个「死亡多于出生」的年
    let peak = -1;
    let trough = -1;
    let cross = '';
    years.forEach((y, i) => {
      const b = births[i];
      if (b === null) return;
      if (peak < 0 || b > births[peak]) peak = i;
      if (trough < 0 || b < births[trough]) trough = i;
      if (!cross && deaths[i] !== null && b < deaths[i]) cross = y;
    });

    const option = baseOption();
    // 顶部留出两层高度：第一层图例，第二层政策底带的文字
    option.grid.top = 46;
    option.xAxis.data = years;
    option.xAxis.boundaryGap = true;
    option.yAxis.name = '万人';
    option.yAxis.nameGap = 12;
    option.yAxis.nameTextStyle = { color: COLOR.muted, fontSize: 11 };
    option.tooltip.formatter = (params) => {
      const i = params[0].dataIndex;
      const one = (name, v) => name + '　' + (v === null || v === undefined ? '—' : fmtNum(v, 1) + ' 万人');
      return (
        yearCn(years[i]) +
        '<br/>' +
        one('出生人口（计算值）', births[i]) +
        '<br/>' +
        one('死亡人口（计算值）', deaths[i]) +
        '<br/>' +
        one('自然增长量（计算值）', net[i])
      );
    };

    const bar = (name, data, color) => ({
      name: name,
      type: 'bar',
      barMaxWidth: 14,
      data: data,
      itemStyle: { color: color },
      emphasis: { focus: 'series' },
    });

    // 政策节点：用淡色底带标出两次生育政策窗口。
    // 不插竖线，因为 2021（三孩）和 2022（生死交叉）相邻，两条竖向标签会叠在一起
    const policyAreas = [];
    if (years.indexOf('2016') !== -1 && years.indexOf('2017') !== -1) {
      policyAreas.push([
        { name: '2016 全面二孩', xAxis: '2016', itemStyle: { color: 'rgba(43,110,214,0.05)' } },
        { xAxis: '2017' },
      ]);
    }
    if (years.indexOf('2021') !== -1) {
      policyAreas.push([
        { name: '2021 三孩', xAxis: '2021', itemStyle: { color: 'rgba(123,92,214,0.05)' } },
        { xAxis: years[years.length - 1] },
      ]);
    }

    // 极值标注：文字写在柱顶上方，加半透明白底，否则会压在相邻柱体上看不清
    const marks = [];
    if (peak >= 0) {
      marks.push({ coord: [years[peak], births[peak]], value: years[peak] + ' 峰 ' + fmtNum(births[peak], 0) });
    }
    if (trough >= 0 && trough !== peak) {
      marks.push({ coord: [years[trough], births[trough]], value: years[trough] + ' 谷 ' + fmtNum(births[trough], 0) });
    }

    option.series = [
      Object.assign(bar('出生人口', births, COLOR.accent), {
        markArea: policyAreas.length
          ? {
              silent: true,
              label: { position: 'top', color: COLOR.muted, fontSize: 10 },
              data: policyAreas,
            }
          : undefined,
        markPoint: {
          symbol: 'circle',
          symbolSize: 7,
          itemStyle: { color: COLOR.accent },
          label: {
            position: 'top',
            distance: 6,
            color: COLOR.accent,
            fontSize: 11,
            fontWeight: 600,
            backgroundColor: 'rgba(255,255,255,0.9)',
            padding: [1, 3],
            borderRadius: 3,
            formatter: (p) => p.value,
          },
          data: marks,
        },
        markLine: cross
          ? {
              silent: true,
              symbol: 'none',
              label: {
                // 总人口 2021 年见顶、2022 年首次下降，与生死交叉是同一年同一件事。
                // 标签放底部：顶部已经被图例和政策底带文字占满，放上面会叠在一起
                formatter: cross + ' 起死亡>出生\n总人口同步转负',
                position: 'insideEndBottom',
                rotate: 0,
                color: COLOR.ink,
                fontSize: 10,
                backgroundColor: 'rgba(255,255,255,0.85)',
                padding: [2, 4],
              },
              lineStyle: { color: COLOR.ink, type: 'dashed', width: 1 },
              data: [{ xAxis: cross }],
            }
          : undefined,
      }),
      bar('死亡人口', deaths, '#9aa3b2'),
      lineSeries('自然增长量', net, COLOR.orange, {
        smooth: false,
        lineStyle: { width: 2, color: COLOR.orange },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { formatter: '0 万人', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
          lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      }),
    ];
    chartOf('chart-birthdeath').setOption(option, true);
  }

  /** 出生死亡比：1.0 为生死平衡，跌破 1 之后死亡多于出生 */
  function renderBirthRatio() {
    const years = yearsOf();
    const ind = byId('birth_death_ratio');
    if (!ind || !years.length) return emptyChart('chart-ratio', '暂无数据');
    const values = seriesOf('birth_death_ratio');

    const option = baseOption();
    option.grid.top = 16;
    option.legend.show = false;
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}';
    option.tooltip.formatter = (params) => {
      const p = params[0];
      return yearCn(years[p.dataIndex]) + '<br/>出生死亡比　' + (p.value === null ? '—' : fmtNum(p.value, 2) + ' 倍');
    };
    option.series = [
      lineSeries('出生死亡比', values, COLOR.violet, {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(123,92,214,0.16)' },
              { offset: 1, color: 'rgba(123,92,214,0.01)' },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { formatter: '1.0 生死平衡', color: COLOR.muted, fontSize: 11, position: 'insideEndTop' },
          lineStyle: { color: COLOR.lineStrong, type: 'dashed', width: 1 },
          data: [{ yAxis: 1 }],
        },
      }),
    ];
    chartOf('chart-ratio').setOption(option, true);
  }

  /** 人口结构：三段堆叠柱 + 65 岁以上占比（本页现算） */
  function renderPopulation() {
    const years = yearsOf();
    if (!years.length || !byId('pop_0_14') || !byId('pop_65')) {
      return emptyChart('chart-population', '暂无数据');
    }

    const young = seriesOf('pop_0_14');
    const work = seriesOf('pop_15_64');
    const old = seriesOf('pop_65');
    const total = seriesOf('total_population');
    // 65 岁以上占比：两个原值都有的年份才算，不插值
    const shares = years.map((y, i) => {
      if (old[i] === null || total[i] === null || !total[i]) return null;
      return Math.round((old[i] / total[i]) * 1000) / 10;
    });

    const option = baseOption();
    option.grid.right = 52;
    option.xAxis.data = years;
    option.xAxis.boundaryGap = true;
    option.yAxis = [
      Object.assign({}, option.yAxis, {
        name: '万人',
        nameGap: 12,
        nameTextStyle: { color: COLOR.muted, fontSize: 11 },
      }),
      {
        type: 'value',
        name: '占比',
        position: 'right',
        nameTextStyle: { color: COLOR.muted, fontSize: 11 },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: COLOR.muted, fontSize: 11, formatter: '{value}%' },
        splitLine: { show: false },
        scale: true,
      },
    ];
    option.tooltip.formatter = (params) => {
      const i = params[0].dataIndex;
      const one = (name, v) => name + '　' + (v === null || v === undefined ? '—' : fmtNum(v, 0) + ' 万人');
      return (
        yearCn(years[i]) + '<br/>' +
        one('0—14 岁', young[i]) + '<br/>' +
        one('15—64 岁', work[i]) + '<br/>' +
        one('65 岁及以上', old[i]) + '<br/>' +
        '65 岁以上占比（计算值）　' + (shares[i] === null ? '—' : fmtNum(shares[i], 1) + '%')
      );
    };
    const bar = (name, data, color) => ({
      name: name,
      type: 'bar',
      stack: 'pop',
      barMaxWidth: 20,
      data: data,
      itemStyle: { color: color },
    });
    option.series = [
      bar('0—14 岁', young, COLOR.accent),
      bar('15—64 岁', work, '#8fb2f2'),
      bar('65 岁及以上', old, COLOR.orange),
      {
        name: '65 岁以上占比（计算值）',
        type: 'line',
        yAxisIndex: 1,
        data: shares,
        showSymbol: false,
        smooth: 0.25,
        connectNulls: false,
        lineStyle: { width: 2, color: COLOR.violet, type: 'dashed' },
        itemStyle: { color: COLOR.violet },
      },
    ];
    chartOf('chart-population').setOption(option, true);
  }

  /** 抚养比：三条官方线，/100 名劳动年龄人口 */
  function renderDependency() {
    const years = yearsOf();
    if (!years.length || (!byId('dependency_ratio') && !byId('aged_dependency'))) {
      return emptyChart('chart-dependency', '暂无数据');
    }
    const option = baseOption();
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}%';
    option.tooltip.formatter = (params) => {
      const head = yearCn(years[params[0].dataIndex]);
      const rows = params
        .map((p) => p.seriesName + '　' + (p.value === null || p.value === undefined ? '—' : fmtNum(p.value, 1) + '%'))
        .join('<br/>');
      return head + '<br/>' + rows;
    };
    const series = [];
    if (byId('dependency_ratio')) series.push(lineSeries('总抚养比', seriesOf('dependency_ratio'), COLOR.ink));
    if (byId('child_dependency')) series.push(lineSeries('少儿抚养比', seriesOf('child_dependency'), COLOR.accent));
    if (byId('aged_dependency')) series.push(lineSeries('老年抚养比', seriesOf('aged_dependency'), COLOR.orange));
    option.series = series;
    chartOf('chart-dependency').setOption(option, true);
  }

  /** 预期寿命：稀疏序列，不画平滑曲线、保留数据点 */
  function renderLife() {
    const years = yearsOf();
    if (!years.length || !byId('life_expectancy')) return emptyChart('chart-life', '暂无数据');
    const option = baseOption();
    option.xAxis.data = years;
    option.yAxis.axisLabel.formatter = '{value}';
    option.tooltip.formatter = (params) => {
      const head = yearCn(years[params[0].dataIndex]);
      const rows = params
        .map((p) => p.seriesName + '　' + (p.value === null || p.value === undefined ? '—' : fmtNum(p.value, 2) + ' 岁'))
        .join('<br/>');
      return head + '<br/>' + rows;
    };
    // 隔了几年才有一个点，平滑曲线会把「10 年跨一步」画成「逐年连着涨」
    const sparse = { smooth: false, showSymbol: true, symbolSize: 6 };
    option.series = [
      lineSeries('平均', seriesOf('life_expectancy'), COLOR.ink, sparse),
      lineSeries('男性', seriesOf('life_expectancy_male'), COLOR.accent, sparse),
      lineSeries('女性', seriesOf('life_expectancy_female'), COLOR.orange, sparse),
    ];
    chartOf('chart-life').setOption(option, true);
  }

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
        ? fmtNum(latest.value, ind.decimals) + '<small>' + unitSuffix(ind) + '</small>'
        : '—';

      card.innerHTML =
        '<div class="kpi-label">' +
        cfg.label +
        (ind.computed ? ' <span class="tag">计算值</span>' : '') +
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
        (ind.source === 'nbs' ? '国家统计局' : ind.computed ? '本页计算' : '—') +
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

  /** 把当前年份区间写回地址栏：预设只留 range，自定义区间留 from/to */
  function syncQuery() {
    const custom = state.range === 'custom';
    Board.setQs({
      range: custom ? null : state.range,
      from: custom ? state.from : null,
      to: custom ? state.to : null,
    });
  }

  const CHART_IDS = [
    'chart-population',
    'chart-birthdeath',
    'chart-dependency',
    'chart-life',
    'chart-marriage',
    'chart-first',
    'chart-change',
    'chart-ratio',
    'chart-rate',
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
      syncQuery();
    } catch (e) {
      setStatus('加载失败：' + (e.message || e), 'error');
      if (!state.data) CHART_IDS.forEach((id) => emptyChart(id, '加载失败'));
    } finally {
      clearHint();
      state.loading = false;
      el.refresh.disabled = false;
    }
  }

  /* ---------------- 导出 CSV ---------------- */

  /**
   * 宽表：一行一年，一列一个指标，列名带单位。
   * 标了 computed 的指标写「本页计算」，避免导出后被当成官方发布值引用。
   */
  function buildCsv() {
    const d = state.data;
    if (!d) {
      window.alert('还没有数据可导出。');
      return;
    }
    const years = yearsOf();
    const columns = [{ key: 'year', label: '年份' }].concat(
      d.indicators.map((ind) => ({
        key: ind.id,
        label: ind.shortLabel || ind.label,
        unit: unitOf(ind),
        calc: !!ind.computed,
      }))
    );
    const rows = years.map((year) => {
      const row = { year: year };
      d.indicators.forEach((ind) => {
        const pt = ind.points.filter((p) => p.year === year)[0];
        row[ind.id] = pt && pt.value !== null ? pt.value : '';
      });
      return row;
    });

    Board.csv(
      {
        file: 'livelihood',
        fileSuffix: d.range.from + '_' + d.range.to,
        module: '中国人口与婚育看板',
        source: '国家统计局 · 国家数据（年度）',
        interface: '/api/livelihood/overview',
        range: yearCn(d.range.from) + ' ~ ' + yearCn(d.range.to) + '（' + d.range.label + '）',
        note: [
          '人口数为年末口径；抚养比、预期寿命、结婚登记等不同序列量纲不同，未做任何换算与合成',
          '出生人口 / 死亡人口 / 自然增长量 / 生死比 / 65 岁以上占比 为本页计算值：千分率 × 年平均人口 ÷ 1000',
          '自然增长率取官方发布值，不由本页用出生率减死亡率代替',
        ],
      },
      [{ title: '指标年度序列', columns: columns, rows: rows }]
    );
  }

  Board.onExport(el.exportBtn, buildCsv);

  function renderAll() {
    renderKpi();
    renderPopulation();
    renderBirthDeath();
    renderDependency();
    renderLife();
    renderMarriage();
    renderFirst();
    renderChange();
    renderBirthRatio();
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
      syncQuery();
      if (yearOk(state.from) && yearOk(state.to)) load(false);
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
    if (state.range === 'custom' && yearOk(state.from) && yearOk(state.to)) load(false);
  });

  el.to.addEventListener('change', () => {
    state.to = el.to.value;
    savePref();
    syncQuery();
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
