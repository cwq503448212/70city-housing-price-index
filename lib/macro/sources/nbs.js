'use strict';

/**
 * 数据源一：国家统计局「国家数据」新版站点（data.stats.gov.cn）
 *
 * 背景：老版 EasyQuery 接口（easyquery.htm?m=QueryData…）已被站点 WAF 全域拦截
 *      （403 / reason:UrlACL），浏览器直接访问同样是 403。新版站点改走
 *      /dg/website/publicrelease/web/external/ 下的三个内部接口，本项目以此为主源：
 *
 *        GET  …/new/queryIndexTreeAsync?pid=&code=1     栏目树
 *        GET  …/new/queryIndicatorsByCid?cid=&dt=&name= 栏目下的指标清单
 *        POST …/stream/esData                          取数（一次可带多个指标）
 *
 * 依然是「网站前端内部接口」，不是官方开放 API，没有任何稳定性承诺。
 * 所有请求都经过 util/queue 串行化，失败就回退缓存 / DBnomics，绝不空数组。
 */

const config = require('../config');
const { createClient } = require('../util/net');
const { serialize, gate, sleep } = require('../util/queue');

const SITE = 'https://data.stats.gov.cn';
const EXT = '/dg/website/publicrelease/web/external';
/** 两次对外请求的最小间隔；站点连发请求会直接回 WAF 302 */
const GAP_MS = 1200;

const client = createClient({
  baseUrl: SITE,
  timeout: 30000,
  headers: {
    Accept: 'application/json, text/plain, */*',
    Referer: SITE + '/dg/website/page.html',
    Origin: SITE,
  },
});

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

async function withRetry(label, task, attempts) {
  const max = attempts || 3;
  let lastErr = null;
  for (let i = 0; i < max; i += 1) {
    try {
      return await serialize(async () => {
        await gate(GAP_MS);
        return task();
      });
    } catch (e) {
      lastErr = e;
      if (i < max - 1) await sleep(3000 * (i + 1));
    }
  }
  throw new Error(label + ' 失败：' + (lastErr && lastErr.message ? lastErr.message : '未知错误'));
}

/** 栏目树（探测用） */
async function tree(pid) {
  const url = EXT + '/new/queryIndexTreeAsync?pid=' + encodeURIComponent(pid || '') + '&code=1';
  const json = await withRetry('读取栏目树', () => client.requestJson(url));
  return (json && json.data) || [];
}

/** 栏目下的指标清单（探测用） */
async function indicatorsOf(catalogId) {
  const url = EXT + '/new/queryIndicatorsByCid?cid=' + encodeURIComponent(catalogId) + '&dt=&name=';
  const json = await withRetry('读取指标清单', () => client.requestJson(url));
  const list = (json && json.data && json.data.list) || [];
  return list.map((x) => ({
    id: x._id,
    name: x._name,
    shown: String(x.i_showname || '').trim(),
    unit: x.du_name || '',
    sdate: x.daterange_sdate || '',
    edate: x.daterange_edate || '',
  }));
}

/**
 * 取一个栏目下若干指标在一段月份区间内的数据（一次请求搞定多个指标）
 * @param {object} p
 * @param {string} p.catalogId 栏目 id
 * @param {string[]} p.indicatorIds 指标 id 列表
 * @param {string} p.from 'YYYY-MM'
 * @param {string} p.to 'YYYY-MM'
 * @returns {Promise<Object>} { [indicatorId]: { [month]: number } }
 */
async function fetchRange(p) {
  const s = config.settings();
  const body = {
    cid: p.catalogId,
    indicatorIds: p.indicatorIds,
    daCatalogId: '',
    das: [{ text: '全国', value: '000000000000' }],
    showType: 1,
    rootId: s.rootId,
    dts: [periodCode(p.from) + '-' + periodCode(p.to)],
  };

  const json = await withRetry('取数（' + p.catalogId + '）', () =>
    client.requestJson(EXT + '/stream/esData', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body),
    })
  );

  const rows = (json && json.data) || [];
  const out = {};
  p.indicatorIds.forEach((id) => {
    out[id] = {};
  });

  rows.forEach((row) => {
    const month = monthOf(row.code);
    if (!month) return;
    (row.values || []).forEach((v, idx) => {
      if (!v) return;
      // values[] 自带 _id（= 指标 id），比按顺序对齐更可靠；缺失时退回下标
      const target = v._id || p.indicatorIds[idx];
      if (!target || !out[target]) return;
      // 只取全国口径
      if (v.da && v.da !== '000000000000') return;
      const num = v.value === null || v.value === undefined || v.value === '' ? NaN : Number(v.value);
      if (!isFinite(num)) return;
      out[target][month] = num;
    });
  });

  return out;
}

module.exports = { name: 'nbs', label: '国家统计局 · 国家数据', tree, indicatorsOf, fetchRange, periodCode, monthOf };
