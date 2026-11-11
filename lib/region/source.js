'use strict';

/**
 * 数据源：国家统计局「国家数据」分省年度库（data.stats.gov.cn）
 *
 * 与全国年度库同一个站点、同一组站点内部接口，只是库不同：
 *   全国年度库  code=3  rootId = 884c062607104a91967b22742537f44f
 *   分省年度库  code=6  rootId = c4d82af16c3d4f0cb4f09d4af7d5888e ← 本模块
 *
 *   POST …/stream/esData   body = { cid, indicatorIds, das:[{text,value}], dts:['1992YY-2025YY'], rootId }
 *
 * 地区维度：das 传 12 位行政区划代码（北京 110000000000）。
 * **实测 das 一次请求只返回一个地区**（送 8 个省也只回 1 行 values），
 * 所以 31 省必须逐省请求——这也是 service 里逐个省串行补数的原因。
 *
 * 依然是「网站前端内部接口」，不是官方开放 API，没有任何稳定性承诺。
 * 所有请求都经 queue 串行 + 1.2 秒间隔，失败就回退缓存，绝不返回空数组冒充数据。
 */

const config = require('./config');
const { serialize, gate, sleep } = require('./queue');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 两次对外请求的最小间隔；站点连发请求会直接回 WAF 302 */
const GAP_MS = 1200;
const TIMEOUT_MS = 30000;
const RETRIES = 2;

function site() {
  return config.settings().site || {};
}

function url(path) {
  const s = site();
  return String(s.baseUrl || '').replace(/\/$/, '') + path;
}

function headers(extra) {
  const s = site();
  return Object.assign(
    {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: url(s.page || '/'),
      Origin: String(s.baseUrl || '').replace(/\/$/, ''),
    },
    extra || {}
  );
}

/** 统计年 → 站点期别编码：2024 → 2024YY */
function periodCode(year) {
  return String(year) + 'YY';
}

/** 站点期别编码 → 统计年：2024YY → 2024 */
function yearOf(code) {
  const m = /^(\d{4})/.exec(String(code || ''));
  return m ? m[1] : '';
}

async function request(path, options) {
  const o = options || {};
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('请求超时（' + Math.round(TIMEOUT_MS / 1000) + 's）: ' + path)),
    TIMEOUT_MS
  );
  try {
    const res = await fetch(url(path), {
      method: o.method || 'GET',
      signal: ctrl.signal,
      headers: headers(o.headers),
      body: o.body,
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error('HTTP ' + res.status + ' ' + path + '：' + text.slice(0, 120));
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('响应不是 JSON：' + path + '（' + text.slice(0, 120) + '）');
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

/** 栏目树（探测 / 校验用，服务运行时不调用） */
async function tree(pid) {
  const s = site();
  const path =
    (s.ext || '') +
    '/new/queryIndexTreeAsync?pid=' +
    encodeURIComponent(pid || '') +
    '&code=' +
    encodeURIComponent(String(s.code || 6));
  const json = await withRetry('读取分省栏目树', () => request(path));
  return (json && json.data) || [];
}

/** 栏目下的指标清单（探测 / 校验用） */
async function indicatorsOf(catalogId) {
  const s = site();
  const path = (s.ext || '') + '/new/queryIndicatorsByCid?cid=' + encodeURIComponent(catalogId) + '&dt=&name=';
  const json = await withRetry('读取栏目指标清单', () => request(path));
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
 * 取一个栏目下若干指标在 [from, to] 年度区间内的数据（一次请求，单个省份）
 * @param {object} p
 * @param {string} p.catalogId 栏目 id
 * @param {string[]} p.indicatorIds 指标 id 列表
 * @param {{code:string,name:string}} p.province 省份（das 只放这一个）
 * @param {string} p.from 'YYYY'
 * @param {string} p.to 'YYYY'
 * @returns {Promise<Object>} { [indicatorId]: { [year]: number } }
 */
async function fetchRange(p) {
  const s = site();
  const prov = p.province || {};
  if (!/^\d{12}$/.test(String(prov.code || ''))) throw new Error('省份代码必须是 12 位行政区划码');

  const body = {
    cid: p.catalogId,
    indicatorIds: p.indicatorIds,
    daCatalogId: '',
    das: [{ text: prov.name || '', value: prov.code }],
    showType: 1,
    rootId: s.rootId,
    dts: [periodCode(p.from) + '-' + periodCode(p.to)],
  };

  const json = await withRetry('取数（' + prov.name + ' · ' + p.catalogId + '）', () =>
    request((s.ext || '') + '/stream/esData', {
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
    const year = yearOf(row.code);
    if (!year) return;
    if (year < p.from || year > p.to) return;
    (row.values || []).forEach((v, idx) => {
      if (!v) return;
      // values[] 自带 _id（= 指标 id），比按顺序对齐更可靠；缺失时退回下标
      const target = v._id || p.indicatorIds[idx];
      if (!target || !out[target]) return;
      // 只取本次请求的那个省（das 虽只传一个，仍按 da 校验一遍）
      if (v.da && String(v.da) !== String(prov.code)) return;
      // 上游没发布的年度是空串：跳过，不写 0；空洞由服务层按需补 null 占位
      const num = v.value === null || v.value === undefined || v.value === '' ? NaN : Number(v.value);
      if (!isFinite(num)) return;
      out[target][year] = num;
    });
  });

  return out;
}

module.exports = {
  name: 'nbs-region',
  label: '国家统计局 · 国家数据（分省年度）',
  tree,
  indicatorsOf,
  fetchRange,
  periodCode,
  yearOf,
  GAP_MS,
};
