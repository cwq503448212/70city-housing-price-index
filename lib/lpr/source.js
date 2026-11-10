'use strict';

/**
 * 上游取数：中国货币网 LprHis 接口（POST）
 *
 * 站点有 WAF：必须带浏览器 UA 与 Referer；HTTP 200 且 head.rep_code === '200' 才算成功。
 * Node >= 20 自带全局 fetch，直接用（该站接口无重定向 / Cookie 依赖，不需要 macro 那套拼装）。
 *
 * 上游限制：一次查询跨度超过一年时返回空 records（只提供一年历史数据查询），
 * 所以拉全历史要按自然年分段请求（约 8 段）再按日期去重合并；段间留间隔，礼貌抓取。
 */

const { SITE, HTTP } = require('./config');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(d, name) {
  if (!DATE_RE.test(d || '')) throw new Error(name + ' 格式应为 YYYY-MM-DD：' + d);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function once(from, to) {
  const url = SITE.origin + SITE.path + '?lang=CN&strStartDate=' + from + '&strEndDate=' + to;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('请求超时（' + Math.round(HTTP.timeoutMs / 1000) + 's）')),
    HTTP.timeoutMs
  );
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: SITE.page,
        Origin: SITE.origin,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error('HTTP ' + res.status + '：' + text.slice(0, 120));
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('响应不是 JSON：' + text.slice(0, 120));
    }
    if (!json || !json.head || json.head.rep_code !== '200') {
      throw new Error('上游返回异常：' + (json && json.head ? json.head.rep_code : text.slice(0, 120)));
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** 期限字段名以 baseCurveCfgList 为准（1 年期 / 5 年期以上），防站点改列名 */
function termKeys(cfgList) {
  const list = Array.isArray(cfgList) && cfgList.length ? cfgList : ['1Y', '5Y'];
  const k1 = list.find((k) => /^1Y$/i.test(k)) || '1Y';
  const k5 = list.find((k) => /^5Y/i.test(k)) || '5Y';
  return { k1: k1, k5: k5 };
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** 把 [from, to] 按自然年切段（首尾段取实际边界，每段跨度 ≤ 12 个月） */
function splitWindows(from, to) {
  const windows = [];
  const startY = Number(from.slice(0, 4));
  const endY = Number(to.slice(0, 4));
  for (let y = startY; y <= endY; y += 1) {
    const segFrom = y === startY ? from : y + '-01-01';
    const segTo = y === endY ? to : y + '-12-31';
    if (segFrom <= segTo) windows.push({ from: segFrom, to: segTo });
  }
  return windows;
}

/** 单段取数，带递增间隔重试 */
async function fetchSegment(from, to) {
  let lastErr;
  for (let i = 0; i <= HTTP.retries; i += 1) {
    try {
      return await once(from, to);
    } catch (e) {
      lastErr = e;
      if (i < HTTP.retries) await sleep(HTTP.retryGapMs * (i + 1));
    }
  }
  throw new Error('中国货币网取数失败（' + from + ' ~ ' + to + '）：' + (lastErr ? lastErr.message : String(lastErr)));
}

/**
 * 拉取 [from, to] 的全部 LPR 报价（按年分段），按日期升序、去重
 * @returns {Promise<{records:Array<{date:string,y1:number|null,y5:number|null}>, source:string}>}
 */
async function fetchAll(from, to) {
  assertDate(from, 'from');
  assertDate(to, 'to');
  const windows = splitWindows(from, to);
  const merged = new Map();
  for (let i = 0; i < windows.length; i += 1) {
    if (i > 0) await sleep(HTTP.segmentGapMs);
    const json = await fetchSegment(windows[i].from, windows[i].to);
    const keys = termKeys(json.data && json.data.baseCurveCfgList);
    const rows = Array.isArray(json.records) ? json.records : [];
    rows.forEach((r) => {
      if (!DATE_RE.test(r.showDateCN || '')) return;
      merged.set(r.showDateCN, { date: r.showDateCN, y1: toNum(r[keys.k1]), y5: toNum(r[keys.k5]) });
    });
  }
  const records = Array.from(merged.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  return { records: records, source: 'chinamoney' };
}

module.exports = { fetchAll };
