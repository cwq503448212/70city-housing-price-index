'use strict';

/**
 * 数据源：国家统计局「国家数据」（data.stats.gov.cn）
 *
 * 同一个站点、同一组内部接口，本模块同时用两个库：
 *   月度库 rootId = fc982599aa684be7969d7b90b1bd0e84（城镇调查失业率 / 周平均工时）
 *   年度库 rootId = 884c062607104a91967b22742537f44f（农民工、登记失业）
 *
 *   GET  …/new/queryIndexTreeAsync?pid=&code=1|3   栏目树（探测用）
 *   GET  …/new/queryIndicatorsByCid?cid=&dt=&name= 栏目下的指标清单（探测用）
 *   POST …/stream/esData                          取数，一次请求可带同栏目的多个指标
 *
 * 期别编码：月度 2026-09 → 202609MM，年度 2025 → 2025YY。
 * 老版 EasyQuery 接口已被 WAF 全域拦截（403 / UrlACL），不要回退到那条路由。
 * 站点对高频请求很敏感：所有请求经父目录 queue 串行 + 1.2 秒最小间隔，失败重试两次。
 *
 * 返回结构：{ series: { [indicatorId]: { 期别: number } }, periods, rows }
 * 只取全国口径（das = 000000000000）；空值丢掉，不补 0。
 */

const config = require('./config');
const { serialize, gate, sleep } = require('../queue');

/** 两次对外请求的最小间隔；站点连发请求会直接回 WAF 302 */
const GAP_MS = 1200;
const TIMEOUT_MS = 30000;
const RETRIES = 2;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function site() {
  return config.site();
}

/** 统计月 → 站点期别编码：2026-10 → 202610MM */
function monthCode(month) {
  return String(month).replace('-', '') + 'MM';
}

/** 统计年 → 站点期别编码：2025 → 2025YY */
function yearCode(year) {
  return String(year) + 'YY';
}

/** 站点期别编码 → 统计期别：202610MM → 2026-10，2025YY → 2025 */
function periodOf(code) {
  const raw = String(code || '');
  const m = /^(\d{4})(\d{2})?/.exec(raw);
  if (!m) return '';
  return m[2] ? m[1] + '-' + m[2] : m[1];
}

function codeOf(freq, period) {
  return freq === 'year' ? yearCode(period) : monthCode(period);
}

function rootIdOf(freq) {
  const s = site();
  return freq === 'year' ? s.annualRootId : s.monthlyRootId;
}

async function requestJson(pathname, init) {
  const s = site();
  const target = String(s.baseUrl || '').replace(/\/$/, '') + pathname;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('请求超时（' + Math.round(TIMEOUT_MS / 1000) + 's）')),
    TIMEOUT_MS
  );
  try {
    const res = await fetch(target, {
      method: (init && init.method) || 'GET',
      signal: ctrl.signal,
      headers: Object.assign(
        {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: String(s.baseUrl || '').replace(/\/$/, '') + (s.page || '/'),
          Origin: String(s.baseUrl || '').replace(/\/$/, ''),
        },
        (init && init.headers) || {}
      ),
      body: init && init.body,
    });
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error('HTTP ' + res.status + '：' + text.slice(0, 120));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      // 被 WAF 拦下时会返回登录页 / HTML，这里当成失败交给上层回退缓存
      throw new Error('返回的不是 JSON：' + text.replace(/\s+/g, ' ').slice(0, 120));
    }
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(label, task) {
  let lastErr = null;
  for (let i = 0; i <= RETRIES; i += 1) {
    try {
      return await serialize(async () => {
        await gate(GAP_MS);
        return task();
      });
    } catch (e) {
      lastErr = e;
      if (i < RETRIES) await sleep(3000 * (i + 1));
    }
  }
  throw new Error(label + ' 失败：' + (lastErr && lastErr.message ? lastErr.message : '未知错误'));
}

/** 栏目树（探测 / 排障用，日常不调用） */
async function tree(freq, pid) {
  const code = freq === 'year' ? 3 : 1;
  const url = site().ext + '/new/queryIndexTreeAsync?pid=' + encodeURIComponent(pid || '') + '&code=' + code;
  const json = await withRetry('读取栏目树', () => requestJson(url));
  return (json && json.data) || [];
}

/** 栏目下的指标清单（探测 / 排障用，日常不调用） */
async function indicatorsOf(catalogId) {
  const url = site().ext + '/new/queryIndicatorsByCid?cid=' + encodeURIComponent(catalogId) + '&dt=&name=';
  const json = await withRetry('读取指标清单', () => requestJson(url));
  return ((json && json.data && json.data.list) || []).map((x) => ({
    id: x._id,
    name: x._name,
    shown: String(x.i_showname || '').trim(),
    unit: x.du_name || '',
    sdate: x.daterange_sdate || '',
    edate: x.daterange_edate || '',
  }));
}

/**
 * 拉一个栏目下若干指标的一段期别区间
 * @param {object} p
 * @param {string} p.freq 'month' | 'year'
 * @param {string} p.catalogId 栏目 id
 * @param {string[]} p.indicatorIds 指标 id 列表（必须是同一栏目）
 * @param {string} p.from 期别（YYYY-MM 或 YYYY）
 * @param {string} p.to 期别
 * @returns {Promise<{series:Object, periods:number, rows:number}>}
 */
async function fetchCatalog(p) {
  const body = {
    cid: p.catalogId,
    indicatorIds: p.indicatorIds,
    daCatalogId: '',
    das: [{ text: '全国', value: '000000000000' }],
    showType: 1,
    rootId: rootIdOf(p.freq),
    dts: [codeOf(p.freq, p.from) + '-' + codeOf(p.freq, p.to)],
  };

  const json = await withRetry('取数（' + p.catalogId + '）', () =>
    requestJson(site().ext + '/stream/esData', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body),
    })
  );

  const rows = (json && json.data) || [];
  const series = {};
  p.indicatorIds.forEach((id) => {
    series[id] = {};
  });
  const periods = new Set();

  rows.forEach((row) => {
    const period = periodOf(row.code);
    if (!period) return;
    (row.values || []).forEach((v, idx) => {
      if (!v) return;
      // values[] 自带 _id（= 指标 id），比按顺序对齐更可靠；缺失时退回下标
      const target = v._id || p.indicatorIds[idx];
      if (!target || !series[target]) return;
      // 只要全国口径
      if (v.da && v.da !== '000000000000') return;
      const num = v.value === null || v.value === undefined || v.value === '' ? NaN : Number(v.value);
      if (!isFinite(num)) return;
      series[target][period] = num;
      periods.add(period);
    });
  });

  return { series: series, periods: periods.size, rows: rows.length };
}

module.exports = {
  name: 'nbs',
  label: '国家统计局 · 国家数据',
  GAP_MS,
  monthCode,
  yearCode,
  periodOf,
  codeOf,
  tree,
  indicatorsOf,
  fetchCatalog,
};
