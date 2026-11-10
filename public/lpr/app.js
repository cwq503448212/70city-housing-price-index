'use strict';

/**
 * 房贷利率 LPR 看板 —— 前端渲染
 *
 * 数据只有一次请求：/api/lpr/overview
 * 前端不判断「哪天该有新一期」——那是服务端 lib/lpr/policy.js 的事，这里只消费 stale / refreshing 字段。
 * 数值口径：y1 / y5 存原始百分数（3.5 = 3.50%），调整幅度换算成 bp（1bp = 0.01 个百分点）展示。
 */

(function () {
  const COLOR = {
    ink: '#16181d',
    muted: '#7b8391',
    line: '#e8eaee',
    lineStrong: '#d9dce2',
    accent: '#175cd3',
    orange: '#e08a2f',
    up: '#d14343',
    down: '#1f9254',
    flat: '#98a1ae',
  };

  const TERM = {
    y1: { label: '1 年期', color: COLOR.accent },
    y5: { label: '5 年期以上', color: COLOR.orange },
  };

  // 用户可调的筛选条件存 localStorage：改默认值必须同时升级键名（v1 → v2）
  const LS_KEY = 'lpr.range.v1';

  const state = {
    range: 'all',
    data: null,
    loading: false,
    polls: 0,
    charts: {},
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    range: $('range'),
    refresh: $('refresh'),
    status: $('status'),
    rangeHint: $('range-hint'),
    kpiRow: $('kpi-row'),
    table: $('detail-table').querySelector('tbody'),
    footMeta: $('foot-meta'),
  };

  /* ---------------- 基础格式 ---------------- */

  function fmtPct(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return v.toFixed(2) + '%';
  }

  function fmtBp(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const bp = Math.round(v * 100);
    return (bp > 0 ? '+' : '') + bp + 'bp';
  }

  function signClass(v) {
    if (v === null || v === undefined || !isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  function dateCn(d) {
    if (!d) return '—';
    const p = d.split('-');
    return p[0] + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
  }

  function dateAxis(d) {
    return d.slice(2).replace('-', '/');
  }

  /* ---------------- 数据访问 ---------------- */

  /** 当前视图区间的日期下界（YYYY-MM-DD）；all / 无数据时返回空串 */
  function rangeFrom() {
    if (state.range === 'all') return '';
    const all = (state.data && state.data.records) || [];
    if (!all.length) return '';
    const months = Number(state.range) || 60;
    const last = all[all.length - 1].date;
    const end = new Date(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, Number(last.slice(8, 10)));
    end.setMonth(end.getMonth() - months);
    const pad = (n) => String(n).padStart(2, '0');
    return end.getFullYear() + '-' + pad(end.getMonth() + 1) + '-' + pad(end.getDate());
  }

  /** 相邻两期的变动（bp）；一端缺失就是缺失，不插值 */
  function withDelta(records) {
    return records.map((r, i) => {
      const prev = i > 0 ? records[i - 1] : null;
      const d1 = prev && r.y1 !== null && prev.y1 !== null ? r.y1 - prev.y1 : null;
      const d5 = prev && r.y5 !== null && prev.y5 !== null ? r.y5 - prev.y5 : null;
      return { date: r.date, y1: r.y1, y5: r.y5, d1: d1, d5: d5 };
    });
  }

  /** 最近一次实际调整（任意品种） */
  function lastChange(records) {
    for (let i = records.length - 1; i >= 1; i -= 1) {
      const r = records[i];
      if (r.d1 !== null && r.d1 !== 0) return { date: r.date, term: 'y1', delta: r.d1 };
      if (r.d5 !== null && r.d5 !== 0) return { date: r.date, term: 'y5', delta: r.d5 };
    }
    return null;
  }

  /* ---------------- 请求 ---------------- */

  async function load(force) {
    state.loading = true;
    el.refresh.disabled = true;
    setStatus('loading');
    try {
      const res = await fetch('/api/lpr/overview' + (force ? '?force=1' : ''));
      const data = await res.json();
      state.data = data;
      state.polls = 0;
      render();
      if (data.refreshing) schedulePoll();
    } catch (e) {
      setStatus('error', '请求失败：' + e.message);
    } finally {
      state.loading = false;
      el.refresh.disabled = false;
    }
  }

  /** 后台正在补数：3 秒后重取一次，最多 5 次（约 15 秒），期间页面展示缓存 */
  function schedulePoll() {
    if (state.polls >= 5) return;
    state.polls += 1;
    setTimeout(() => {
      if (!state.loading) load(false);
    }, 3000);
  }

  function setStatus(kind, extra) {
    const d = state.data;
    if (kind === 'loading') {
      el.status.className = 'status';
      el.status.textContent = d && d.status === 'ready' ? '正在核对更新…' : '正在加载…';
      return;
    }
    if (kind === 'error') {
      el.status.className = 'status is-error';
      el.status.textContent = extra || '请求失败';
      return;
    }
    if (!d || d.status === 'empty') {
      el.status.className = 'status is-error';
      el.status.textContent = '暂无数据：' + (d && d.error ? d.error : '上游不可用');
      return;
    }
    if (d.refreshError) {
      el.status.className = 'status is-warn';
      el.status.textContent = '刷新失败，展示本地缓存（' + d.refreshError + '）';
      return;
    }
    if (d.refreshing) {
      el.status.className = 'status is-warn';
      el.status.textContent = '后台核对最新一期中，当前为缓存数据…';
      return;
    }
    if (d.stale) {
      el.status.className = 'status is-warn';
      el.status.textContent = '数据可能滞后（待官方发布 ' + d.expectedLatest + ' 后更新）';
      return;
    }
    const rs = d.records || [];
    el.status.className = 'status is-ok';
    el.status.textContent = rs.length ? '已就绪 · 共 ' + rs.length + ' 期，最新 ' + rs[rs.length - 1].date : '已就绪';
  }

  /* ---------------- KPI ---------------- */

  function kpiCard(label, valueHtml, footHtml) {
    const div = document.createElement('div');
    div.className = 'kpi';
    const l = document.createElement('div');
    l.className = 'kpi-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'kpi-value';
    v.innerHTML = valueHtml; // 内容全部来自本页拼装的数字/固定文本
    const f = document.createElement('div');
    f.className = 'kpi-foot';
    f.innerHTML = footHtml;
    div.appendChild(l);
    div.appendChild(v);
    div.appendChild(f);
    return div;
  }

  function deltaHtml(v, withDate) {
    if (!v) return '';
    const tail = withDate ? ' <small>' + v.date + '</small>' : '';
    return '<span class="kpi-delta ' + signClass(v.delta) + '">' + fmtBp(v.delta) + '</span>' + tail;
  }

  function renderKpis(records) {
    el.kpiRow.innerHTML = '';
    if (!records.length) return;
    const last = records[records.length - 1];

    el.kpiRow.appendChild(
      kpiCard(
        '1 年期 LPR（最新）',
        fmtPct(last.y1),
        last.d1 === null
          ? '<span>上期缺失</span>'
          : '较上期 <span class="kpi-delta ' + signClass(last.d1) + '">' + fmtBp(last.d1) + '</span>'
      )
    );
    el.kpiRow.appendChild(
      kpiCard(
        '5 年期以上 LPR（最新）',
        fmtPct(last.y5),
        last.d5 === null
          ? '<span>上期缺失</span>'
          : '较上期 <span class="kpi-delta ' + signClass(last.d5) + '">' + fmtBp(last.d5) + '</span>'
      )
    );

    const chg = lastChange(records);
    el.kpiRow.appendChild(
      kpiCard(
        '最近一次调整',
        chg ? fmtBp(chg.delta) : '连续未调',
        chg
          ? '<span>' + dateCn(chg.date) + '</span><span>' + TERM[chg.term].label + '</span>'
          : '<span>区间内无调整</span>'
      )
    );

    const spread = last.y5 !== null && last.y1 !== null ? last.y5 - last.y1 : null;
    const prev = records.length > 1 ? records[records.length - 2] : null;
    const prevSpread = prev && prev.y5 !== null && prev.y1 !== null ? prev.y5 - prev.y1 : null;
    el.kpiRow.appendChild(
      kpiCard(
        '期限利差（5Y − 1Y）',
        spread === null ? '—' : spread.toFixed(2) + '<small>个百分点</small>',
        prevSpread === null
          ? '<span>上期缺失</span>'
          : '较上期 <span class="kpi-delta ' +
              signClass(spread - prevSpread) +
              '">' +
              (spread - prevSpread > 0 ? '+' : '') +
              (spread - prevSpread).toFixed(2) +
              '</span>'
      )
    );
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

  /* ---------------- 各图 ---------------- */

  /** 末值标注 */
  function endMark(value, color) {
    if (value === null || value === undefined) return undefined;
    return {
      markPoint: {
        silent: true,
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: color },
        label: {
          show: true,
          position: 'top',
          distance: 8,
          formatter: () => value.toFixed(2) + '%',
          color: color,
          fontSize: 11,
          fontWeight: 600,
        },
        data: [{ coord: [lastIndex, value] }],
      },
    };
  }

  let lastIndex = 0;

  function renderTrend(rows) {
    if (!rows.length) return emptyChart('chart-lpr', '暂无数据');
    lastIndex = rows.length - 1;
    const dates = rows.map((r) => r.date);
    const series = ['y1', 'y5'].map((k) => {
      const t = TERM[k];
      return {
        name: t.label,
        type: 'line',
        step: 'end',
        data: rows.map((r) => r[k]),
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2, color: t.color },
        itemStyle: { color: t.color },
        emphasis: { focus: 'series' },
        ...endMark(rows[rows.length - 1][k], t.color),
      };
    });

    const option = baseOption();
    option.xAxis.data = dates.map(dateAxis);
    option.yAxis.axisLabel.formatter = '{value}%';
    option.tooltip.formatter = (params) => {
      const head = dateCn(dates[params[0].dataIndex]);
      const line = (p) => {
        const v = p.value;
        return p.seriesName + '　' + (v === null || v === undefined ? '—' : fmtPct(v));
      };
      return head + '<br/>' + params.map(line).join('<br/>');
    };
    option.series = series;
    chartOf('chart-lpr').setOption(option, true);
  }

  function renderChange(rows) {
    if (!rows.length) return emptyChart('chart-change', '暂无数据');
    const dates = rows.map((r) => r.date);
    const hasChange = rows.some((r) => (r.d1 !== null && r.d1 !== 0) || (r.d5 !== null && r.d5 !== 0));

    const bar = (k) => ({
      name: TERM[k].label,
      type: 'bar',
      barMaxWidth: 12,
      barGap: '20%',
      itemStyle: { color: TERM[k].color }, // 图例色；柱体按涨跌在 data 级覆盖
      data: rows.map((r) => {
        const dv = r['d' + k.slice(1)];
        return {
          value: dv !== null && dv !== 0 ? Math.round(dv * 100) : null,
          itemStyle: { color: dv > 0 ? COLOR.up : COLOR.down, borderRadius: 2 },
        };
      }),
    });

    const option = baseOption();
    option.xAxis.boundaryGap = true;
    option.xAxis.data = dates.map(dateAxis);
    option.yAxis.axisLabel.formatter = '{value}';
    if (!hasChange) {
      return emptyChart('chart-change', '所选区间内 LPR 连续维持不变');
    }
    option.tooltip.formatter = (params) => {
      const head = dateCn(dates[params[0].dataIndex]);
      const line = (p) => {
        const v = p.value;
        return p.seriesName + '　' + (v === null || v === undefined ? '未调整' : (v > 0 ? '+' : '') + v + 'bp');
      };
      return head + '<br/>' + params.map(line).join('<br/>');
    };
    option.series = [bar('y1'), bar('y5')];
    chartOf('chart-change').setOption(option, true);
  }

  function renderSpread(rows) {
    if (!rows.length) return emptyChart('chart-spread', '暂无数据');
    const dates = rows.map((r) => r.date);
    const values = rows.map((r) => (r.y5 !== null && r.y1 !== null ? +(r.y5 - r.y1).toFixed(4) : null));
    const option = baseOption();
    option.legend.show = false;
    option.xAxis.data = dates.map(dateAxis);
    option.tooltip.formatter = (params) => {
      const p = params[0];
      const v = p.value;
      return (
        dateCn(dates[p.dataIndex]) +
        '<br/>5 年期以上 − 1 年期　' + (v === null || v === undefined ? '—' : v.toFixed(2) + ' 个百分点')
      );
    };
    option.series = [
      {
        name: '期限利差',
        type: 'line',
        data: values,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2, color: COLOR.accent },
        itemStyle: { color: COLOR.accent },
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
        emphasis: { focus: 'series' },
      },
    ];
    chartOf('chart-spread').setOption(option, true);
  }

  /* ---------------- 明细表 ---------------- */

  function renderTable(rows) {
    el.table.innerHTML = '';
    const reversed = rows.slice().reverse(); // 与全历史的前一期比好的 d1/d5 已在行上，直接倒序展示
    reversed.forEach((r) => {
      const tr = document.createElement('tr');
      const td = (html, cls) => {
        const c = document.createElement('td');
        if (cls) c.className = cls;
        c.innerHTML = html;
        return c;
      };
      tr.appendChild(td(r.date));
      tr.appendChild(td(fmtPct(r.y1), 'num'));
      tr.appendChild(td(r.d1 === null ? '—' : '<span class="' + signClass(r.d1) + '">' + fmtBp(r.d1) + '</span>', 'num'));
      tr.appendChild(td(fmtPct(r.y5), 'num'));
      tr.appendChild(td(r.d5 === null ? '—' : '<span class="' + signClass(r.d5) + '">' + fmtBp(r.d5) + '</span>', 'num'));
      el.table.appendChild(tr);
    });
  }

  /* ---------------- 总渲染 ---------------- */

  function render() {
    const d = state.data;
    // 先在全历史上算变化（首行要与区间外的前一期比），再按区间过滤
    const allRows = withDelta((d && d.records) || []);
    const from = rangeFrom();
    const viewRows = from ? allRows.filter((r) => r.date >= from) : allRows;

    setStatus('auto');
    renderKpis(viewRows);
    renderTrend(viewRows);
    renderChange(viewRows);
    renderSpread(viewRows);
    renderTable(viewRows);

    if (viewRows.length) {
      el.rangeHint.textContent =
        '展示 ' + viewRows[0].date + ' ~ ' + viewRows[viewRows.length - 1].date + '，共 ' + viewRows.length + ' 期';
    } else {
      el.rangeHint.textContent = '';
    }
    if (d && d.meta) {
      const bits = [];
      if (d.updatedAt) bits.push('缓存更新于 ' + d.updatedAt.replace('T', ' ').slice(0, 16));
      if (d.source) bits.push('来源 ' + d.source);
      if (d.meta.lastSuccess) bits.push('上次回源成功 ' + d.meta.lastSuccess.replace('T', ' ').slice(0, 16));
      if (d.meta.lastError) bits.push('上次回源失败：' + d.meta.lastError);
      el.footMeta.textContent = bits.join('　·　');
    }
  }

  /* ---------------- 事件 ---------------- */

  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && Array.prototype.indexOf.call(el.range.options, new Option('', saved)) >= 0) {
      state.range = saved;
      el.range.value = saved;
    }
  } catch (e) {
    /* localStorage 不可用就用默认值 */
  }

  el.range.addEventListener('change', () => {
    state.range = el.range.value;
    try {
      localStorage.setItem(LS_KEY, state.range);
    } catch (e) {
      /* ignore */
    }
    render();
  });

  el.refresh.addEventListener('click', () => {
    if (!state.loading) load(true);
  });

  window.addEventListener('resize', () => {
    Object.keys(state.charts).forEach((k) => state.charts[k].resize());
  });

  load(false);
})();
