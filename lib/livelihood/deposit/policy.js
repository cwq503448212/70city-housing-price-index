'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算月份）
 *
 * 央行《金融统计数据报告》与信贷收支表在每月 10-15 日左右发布上月数据，
 * 所以「截至今天最晚应该已经发布」的月份是：
 *
 *   当天 >= 15 日 → 上个月（例：2026-11-20 → 2026-10）
 *   当天 <  15 日 → 上上个月（例：2026-11-10 → 2026-09；1 月初同理回退到上一年）
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该年份还没有缓存；
 *   2. 当年缓存的最新月份早于「应发布月份」；
 *   3. 用户手动刷新。
 * 已完结的年份（早于当前年）只要 12 个月齐全就不再回源；缺月份才补。
 */

const COOLDOWN_MS = 60 * 1000;
/** 两次回源尝试的最小间隔，落在 _meta.json 的 lastAttempt 里，进程重启后仍生效 */
const TRY_INTERVAL_MS = 10 * 60 * 1000;

/** 月份平移：('2026-01', -2) → '2025-11' */
function addMonths(key, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Number(delta);
  const y = Math.floor(total / 12);
  const mo = (total % 12 + 12) % 12 + 1;
  return String(y) + '-' + (mo < 10 ? '0' : '') + mo;
}

/** 截至 now，最晚应该已经发布的月份（YYYY-MM） */
function expectedLatestMonth(now) {
  const ref = now || new Date();
  const key = String(ref.getFullYear()) + '-' + (ref.getMonth() + 1 < 10 ? '0' : '') + (ref.getMonth() + 1);
  return addMonths(key, ref.getDate() >= 15 ? -1 : -2);
}

/**
 * 该年份要不要回源
 * @param {object} p
 * @param {string} p.year 统计年
 * @param {string[]} p.cachedMonths 已缓存月份（'01'..'12'）
 * @param {string} [p.expected] 应发布月份，默认按当前时间算
 * @param {Date} [p.now]
 * @param {boolean} [p.force]
 */
function shouldFetchYear(p) {
  const expected = p.expected || expectedLatestMonth(p.now);
  const expYear = expected.slice(0, 4);
  const expMonth = expected.slice(5, 7);
  const year = String(p.year);
  const cached = (p.cachedMonths || []).slice().sort();
  const latestCached = cached.length ? year + '-' + cached[cached.length - 1] : '';

  if (p.force) return { fetch: true, reason: '手动刷新', expected, latestCached };
  if (!cached.length) return { fetch: true, reason: '无缓存', expected, latestCached };
  if (year > expYear) return { fetch: false, reason: '年份尚未开始发布', expected, latestCached };

  if (year === expYear) {
    if (latestCached >= expected) return { fetch: false, reason: '已对应当前应发布月份', expected, latestCached };
    return { fetch: true, reason: '当年缓存落后应发布月份', expected, latestCached };
  }

  // 已完结年份：12 个月齐全就不再请求（历史数据不会变）
  if (cached.length >= 12) return { fetch: false, reason: '该年度已完整', expected, latestCached };
  return { fetch: true, reason: '该年度缺月份（' + cached.length + '/12）', expected, latestCached };
}

/** 最新缓存月份是否滞后于应发布月份（前端 stale 标记用） */
function isStale(latestMonth, now) {
  if (!latestMonth) return true;
  return String(latestMonth) < expectedLatestMonth(now);
}

module.exports = { COOLDOWN_MS, TRY_INTERVAL_MS, addMonths, expectedLatestMonth, shouldFetchYear, isStale };
