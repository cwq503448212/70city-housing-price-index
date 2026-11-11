'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算月份）
 *
 * 统计局社会消费品零售数据在每月 15 日左右随「国民经济运行情况」一起发布上月数据，
 * 所以「截至今天最晚应该已经发布」的月份是：
 *
 *   当天 >= 15 日 → 上个月（例：2026-11-20 → 2026-10）
 *   当天 <  15 日 → 上上个月（例：2026-11-10 → 2026-09；1 月初同理回退到上一年）
 *
 * 再扣掉「1、2 月合并公布」：
 *   1 月的数据不单独发布（并进 2 月的 1—2 月合计），所以应发布月份不会落在 1 月；
 *   当月值（skipMonths = 01/02）在 2 月也没有值，应发布月份要再回退到上年 12 月；
 *   累计值（skipMonths = 01）在 2 月有 1—2 月合计，正常对应。
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该栏目还没有缓存；
 *   2. 该栏目缓存的最新月份早于它名下指标应发布的月份；
 *   3. 用户手动刷新。
 * 上游已停更的栏目（frozen，如 2025-12 止的旧口径网上零售）拉到数据后不再回源。
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

function monthKey(date) {
  const d = date || new Date();
  const mo = d.getMonth() + 1;
  return String(d.getFullYear()) + '-' + (mo < 10 ? '0' : '') + mo;
}

/** 截至 now，最晚应该已经发布的月份（YYYY-MM）；不会落在 1 月 */
function expectedLatestMonth(now) {
  const ref = now || new Date();
  let month = addMonths(monthKey(ref), ref.getDate() >= 15 ? -1 : -2);
  // 1 月数据并进 2 月的 1—2 月合计，2 月中旬也不会有「1 月」这一期
  if (month.slice(5, 7) === '01') month = addMonths(month, -1);
  return month;
}

/** 某个指标应发布到哪个月（扣掉 1、2 月合并公布的缺失月份） */
function expectedFor(indicator, base) {
  const expected = base || expectedLatestMonth(new Date());
  const skip = (indicator && indicator.skipMonths) || [];
  let month = expected;
  for (let i = 0; i < 3; i += 1) {
    if (skip.indexOf(month.slice(5, 7)) === -1) return month;
    month = addMonths(month, -1);
  }
  return month;
}

/** ['2026-01','2026-02', ...] 含首尾 */
function monthSpan(from, to) {
  const out = [];
  let cur = from;
  while (cur && cur <= to && out.length < 500) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

/** 最新缓存月份是否滞后于应发布月份（前端 stale 标记用） */
function isStale(latestMonth, expected) {
  if (!latestMonth) return true;
  return String(latestMonth) < String(expected || expectedLatestMonth(new Date()));
}

module.exports = {
  COOLDOWN_MS,
  TRY_INTERVAL_MS,
  addMonths,
  monthKey,
  expectedLatestMonth,
  expectedFor,
  monthSpan,
  isStale,
};
