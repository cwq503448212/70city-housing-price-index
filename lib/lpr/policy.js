'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算日期）
 *
 * LPR 每月 20 日 09:15 前公布（遇节假日顺延）。只有三种情况发起远端请求：
 *   1. 本地没有任何缓存（首次打开，一次拉全）；
 *   2. 已过本月发布时刻，而缓存的最新一条还早于本月 20 日；
 *   3. 用户手动刷新。
 * 其余一律直接读缓存。
 *
 * 法定节假日的顺延日期本地算不出来：仍按 20 日判定，没发布就核对一次、拿不到新数据，
 * 顺延后的日子再打开会再核对一次（10 分钟冷却内不重复），行为自然正确。
 */

const { RELEASE, TRY_INTERVAL_MS } = require('./config');

const pad = (n) => String(n).padStart(2, '0');

function dateStr(y, m, d) {
  return y + '-' + pad(m + 1) + '-' + pad(d);
}

/** 截至 now，最晚应该已经公布的发布日（YYYY-MM-DD，按 20 日计） */
function expectedLatestDate(now) {
  const ref = now || new Date();
  const publish = new Date(ref.getFullYear(), ref.getMonth(), RELEASE.day, RELEASE.hour, RELEASE.minute, 0);
  if (ref >= publish) return dateStr(ref.getFullYear(), ref.getMonth(), RELEASE.day);
  const prev = new Date(ref.getFullYear(), ref.getMonth() - 1, RELEASE.day, RELEASE.hour, RELEASE.minute, 0);
  return dateStr(prev.getFullYear(), prev.getMonth(), RELEASE.day);
}

/**
 * 该不该发起请求
 * @param {object} p
 * @param {string|null} p.latestDate 缓存最新一条的发布日（YYYY-MM-DD）
 * @param {object|null} [p.meta] 上次回源元数据（_meta.json，提供 lastAttempt）
 * @param {Date} [p.now]
 * @param {boolean} [p.force] 用户手动刷新（跳过冷却，直接回源）
 * @returns {{fetch:boolean, reason:string, expectedLatest:string}}
 */
function shouldFetch(p) {
  const now = p.now || new Date();
  const expectedLatest = expectedLatestDate(now);
  const lastAttempt = p.meta && p.meta.lastAttempt ? Date.parse(p.meta.lastAttempt) : 0;

  if (p.force) return { fetch: true, reason: '手动刷新', expectedLatest: expectedLatest };
  if (!p.latestDate) return { fetch: true, reason: '无缓存', expectedLatest: expectedLatest };
  if (p.latestDate >= expectedLatest) {
    return { fetch: false, reason: '缓存已是最新', expectedLatest: expectedLatest };
  }
  if (now.getTime() - lastAttempt < TRY_INTERVAL_MS) {
    return { fetch: false, reason: '回源冷却中', expectedLatest: expectedLatest };
  }
  return { fetch: true, reason: '已过发布日，缓存期别滞后', expectedLatest: expectedLatest };
}

/** 数据是否「可能滞后」（用于前端 stale 标记） */
function isStale(latestDate, now) {
  if (!latestDate) return true;
  return latestDate < expectedLatestDate(now);
}

module.exports = { expectedLatestDate, shouldFetch, isStale, TRY_INTERVAL_MS };
