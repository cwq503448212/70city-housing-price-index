'use strict';

/**
 * 数据源：国家统计局「国家数据」月度库（data.stats.gov.cn）
 *
 * 站点前端用的是三个内部接口（不是官方开放 API，没有稳定性承诺）：
 *   GET  …/new/queryIndexTreeAsync?pid=&code=1     栏目树（探测用）
 *   GET  …/new/queryIndicatorsByCid?cid=&dt=&name= 栏目下的指标清单（探测用）
 *   POST …/stream/esData                          取数，一次请求可带同栏目的多个指标
 *
 * 41 个行业的增加值 / 营收 / 利润分属三个栏目，每个栏目一次请求就能拉全；
 * PMI 分项两次请求。首次冷启动共 5 个请求。
 *
 * 老版 EasyQuery 接口已被 WAF 全域拦截（403 / UrlACL），不要回退到那条路由。
 * 站点对高频请求很敏感：本文件内的请求串行 + 1.2 秒最小间隔，失败重试两次。
 * 限流与月份工具都在本模块内实现，不跨模块 require（见 AGENTS.md 的「目录与边界」）。
 *
 * 返回结构：{ series: { [indicatorId]: { 'YYYY-MM': number } }, months, rows }
 * 只取全国口径（das = 000000000000）；空值丢掉，不补 0。
 */

const config = require('./config');

/** 两次对外请求的最小间隔；站点连发请求会直接回 WAF 302 */
const GAP_MS = 1200;
const TIMEOUT_MS = 30000;
const RETRIES = 2;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 模块内限流：同一时刻只允许 1 个对外请求 ---------------- */

let tail = Promise.resolve();
let lastAt = 0;

function serialize(task) {
  const run = tail.then(task, task);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function gate(ms) {
  const wait = lastAt + ms - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

/* ---------------- 期别编码 ---------------- */

function site() {
  return config.site();
}

/** 统计月 → 站点期别编码：2026-10 → 202610MM */
function periodCode(month) {
  return String(month).replace('-', '') + 'MM';
}

/** 站点期别编码 → 统计月：202610MM → 2026-10 */
function monthOf(code) {
  const m = /^(\d{4})(\d{2})/.exec(String(code || ''));
  if (!m) return '';
  return m[1] + '-' + m[2];
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
          Referer: s.baseUrl + '/dg/website/page.html',
          Origin: s.baseUrl,
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
async function tree(pid) {
  const url = site().ext + '/new/queryIndexTreeAsync?pid=' + encodeURIComponent(pid || '') + '&code=1';
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
 * 拉一个栏目下若干指标的一段月份区间
 * @param {object} p
 * @param {string} p.catalogId 栏目 id
 * @param {string[]} p.indicatorIds 指标 id 列表（必须是同一栏目）
 * @param {string} p.from 'YYYY-MM'
 * @param {string} p.to 'YYYY-MM'
 * @returns {Promise<{series:Object, months:number, rows:number}>}
 */
async function fetchCatalog(p) {
  const body = {
    cid: p.catalogId,
    indicatorIds: p.indicatorIds,
    daCatalogId: '',
    das: [{ text: '全国', value: '000000000000' }],
    showType: 1,
    rootId: site().rootId,
    dts: [periodCode(p.from) + '-' + periodCode(p.to)],
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
  const months = new Set();

  rows.forEach((row) => {
    const month = monthOf(row.code);
    if (!month) return;
    (row.values || []).forEach((v, idx) => {
      if (!v) return;
      // values[] 自带 _id（= 指标 id），比按顺序对齐更可靠；缺失时退回下标
      const target = v._id || p.indicatorIds[idx];
      if (!target || !series[target]) return;
      // 只要全国口径
      if (v.da && v.da !== '000000000000') return;
      const num = v.value === null || v.value === undefined || v.value === '' ? NaN : Number(v.value);
      if (!isFinite(num)) return;
      series[target][month] = num;
      months.add(month);
    });
  });

  return { series: series, months: months.size, rows: rows.length };
}

module.exports = {
  name: 'nbs',
  label: '国家统计局 · 国家数据',
  GAP_MS,
  periodCode,
  monthOf,
  tree,
  indicatorsOf,
  fetchCatalog,
};
