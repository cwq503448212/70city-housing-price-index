'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算年份）
 *
 * 年度数据没有固定发布日：一个年度结束后，统计局陆续把人口、教育、房地产
 * 各栏目的年度值补进年度库（教育往往比人口更晚）。所以只按「应发布年度」判定：
 *
 *   当前 3 月及以后 → 应发布上一完整年度（2026-11 时 = 2025）
 *   当前 1-2 月     → 年报尚未入库，仍按前一个年度算（2027-01 时 = 2025）
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该年度还没有缓存；
 *   2. 缓存最新年度早于「应发布年度」；
 *   3. 用户手动刷新。
 * 上游自己没更新（应发布年度查回来是空值）→ 不写入缓存、不伪造，标 stale 由前端提示。
 */

const COOLDOWN_MS = 60 * 1000;
/** 两次回源尝试的最小间隔，落在 _meta.json 的 lastAttempt 里，进程重启后仍生效 */
const TRY_INTERVAL_MS = 10 * 60 * 1000;

/** 截至 now，最晚应该已经发布的年度 */
function expectedLatestYear(now) {
  const ref = now || new Date();
  const year = ref.getFullYear();
  const month = ref.getMonth() + 1;
  return String(month <= 2 ? year - 2 : year - 1);
}

/**
 * 该不该发起请求
 * @param {object} p
 * @param {string[]} p.cachedYears 已缓存年份（升序）
 * @param {string} p.wantFrom 需要的起始年份
 * @param {string} [p.until] 官方停更年份（该指标止于这一年，到了就归档）
 * @param {Date} [p.now]
 * @param {boolean} [p.force]
 * @returns {{fetch:boolean, reason:string, expectedLatest:string, from:string, latestCached:string}}
 */
function shouldFetch(p) {
  const cached = p.cachedYears || [];
  const expectedLatest = expectedLatestYear(p.now);
  const latestCached = cached.length ? cached[cached.length - 1] : '';
  const wantFrom = p.wantFrom || expectedLatest;

  // until：官方已明确停更的序列，缓存到了这一年就视为齐全，不再核对
  if (p.until && latestCached && latestCached >= p.until) {
    return {
      fetch: false,
      reason: '已归档（官方止于 ' + p.until + ' 年）',
      expectedLatest: p.until,
      from: wantFrom,
      latestCached,
    };
  }

  if (p.force) {
    return { fetch: true, reason: '手动刷新', expectedLatest, from: wantFrom, latestCached };
  }
  if (!cached.length) {
    return { fetch: true, reason: '无缓存', expectedLatest, from: wantFrom, latestCached };
  }

  // 区间内有没有完全没落缓存的年度（早期年份上游本身可能为空，不在这里判断）
  const missing = [];
  for (let y = Number(wantFrom); y <= Number(expectedLatest); y += 1) {
    const key = String(y);
    if (cached.indexOf(key) === -1) missing.push(key);
  }
  if (missing.length) {
    return {
      fetch: true,
      reason: '存在未缓存年度（' + missing.length + ' 个）',
      expectedLatest,
      from: missing[0],
      latestCached,
    };
  }

  if (latestCached < expectedLatest) {
    return { fetch: true, reason: '已过发布窗口，缓存年度滞后', expectedLatest, from: wantFrom, latestCached };
  }

  return { fetch: false, reason: '缓存有效', expectedLatest, from: wantFrom, latestCached };
}

module.exports = { COOLDOWN_MS, TRY_INTERVAL_MS, expectedLatestYear, shouldFetch };
