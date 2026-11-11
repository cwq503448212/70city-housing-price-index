'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算月份）
 *
 * 三个栏目各有自己的发布节奏，规则写在 config/industry.json 的 catalogs[].release：
 *   { "day": 15 }     每月 15 日左右发布上月值（工业增加值，随「国民经济运行情况」）
 *   { "day": 27 }     每月 27 日左右发布上月值（工业企业营收 / 利润）
 *   { "day": "eom" }  当月最后一天发布当月值（PMI）
 *
 * 再扣掉本身就不发布的期别（metrics[].skipMonths）：
 *   增加值   skipMonths = ['01','02'] —— 1、2 月合并公布，两个月份都没有当月值
 *   营收利润 skipMonths = ['01']      —— 1 月不单独发布，2 月是 1—2 月累计
 * 应发布月份落在这些月份时往下回退，避免把「本来就不发布」当成「缺数据」。
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该栏目还没有缓存；
 *   2. 该栏目缓存的最新月份早于它名下指标应发布的月份；
 *   3. 用户手动刷新。
 */

const COOLDOWN_MS = 60 * 1000;
/** 两次回源尝试的最小间隔，落在 _meta.json 的 lastAttempt 里，进程重启后仍生效 */
const TRY_INTERVAL_MS = 10 * 60 * 1000;

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function parseMonth(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** '2026-10' → '2026-11'（delta = +1）；非法输入返回 '' */
function addMonths(key, delta) {
  const p = parseMonth(key);
  if (!p) return '';
  const total = p.year * 12 + (p.month - 1) + Number(delta);
  const y = Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12 + 1;
  return String(y) + '-' + pad(mo);
}

function monthKey(date) {
  const d = date || new Date();
  return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1);
}

function daysInMonth(key) {
  const p = parseMonth(key);
  if (!p) return 30;
  return new Date(p.year, p.month, 0).getDate();
}

/** 统计月 month 的发布时刻（本地时间 09:30） */
function publishDate(monthStr, release) {
  const p = parseMonth(monthStr);
  if (!p) return new Date(NaN);
  const rule = release || {};
  if (rule.day === 'eom') {
    return new Date(p.year, p.month - 1, daysInMonth(monthStr), 9, 30, 0);
  }
  const day = Number(rule.day || 15);
  const next = addMonths(monthStr, 1);
  const np = parseMonth(next);
  const safeDay = Math.min(day, daysInMonth(next));
  return new Date(np.year, np.month - 1, safeDay, 9, 30, 0);
}

/** 截至 now，最晚应该已经发布的统计月 */
function expectedLatestMonth(release, now) {
  const ref = now || new Date();
  const cur = monthKey(ref);
  for (let i = 0; i <= 4; i += 1) {
    const candidate = addMonths(cur, -i);
    if (publishDate(candidate, release) <= ref) return candidate;
  }
  return addMonths(cur, -4);
}

/**
 * 某个指标应发布到哪个月（扣掉本身就不发布的月份）
 * @param {object} indicator 指标配置（用它的 skipMonths）
 * @param {object} release 所属栏目的发布日规则（catalogOf(indicator.catalog).release）
 * @param {string} [base] 已算好的应发布月份；不传则按 release 现算
 * @param {Date} [now]
 */
function expectedFor(indicator, release, base, now) {
  const expected = base || expectedLatestMonth(release, now || new Date());
  const skip = (indicator && indicator.skipMonths) || [];
  let month = expected;
  for (let i = 0; i < 3; i += 1) {
    if (skip.indexOf(month.slice(5)) === -1) return month;
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
  return String(latestMonth) < String(expected || '');
}

module.exports = {
  COOLDOWN_MS,
  TRY_INTERVAL_MS,
  pad,
  parseMonth,
  addMonths,
  monthKey,
  daysInMonth,
  publishDate,
  expectedLatestMonth,
  expectedFor,
  monthSpan,
  isStale,
};
