'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算期别）
 *
 * 全部是年度序列，没有月度发布日的概念：按模块统一的 releaseMonth（2 月）
 * 判断「上一年的数据从哪个月起算已发布」：
 *
 *   月份 >= 2 → 应发布上一年
 *   月份 <  2 → 仍是前一年
 *
 * 各省 GDP 在次年 1 月中下旬陆续公布，分省库统一入库更晚，所以落 2 月；
 * 到 2 月还只有前一年，就说明这一期确实没入库，按 10 分钟冷却轻量重试。
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该省还没有缓存；
 *   2. 该省缓存的最新年度早于应发布年度；
 *   3. 用户手动刷新。
 */

const COOLDOWN_MS = 60 * 1000;
/** 两次回源尝试的最小间隔，落在 _meta.json 的 lastAttempt 里，进程重启后仍生效 */
const TRY_INTERVAL_MS = 10 * 60 * 1000;

const YEAR = /^\d{4}$/;

function isYear(v) {
  return YEAR.test(String(v || ''));
}

function currentYear(now) {
  return String((now || new Date()).getFullYear());
}

/** 应发布到哪一年（按模块统一的 releaseMonth） */
function expectedYear(releaseMonth, now) {
  const ref = now || new Date();
  const year = ref.getFullYear();
  const month = ref.getMonth() + 1;
  const release = Number(releaseMonth || 2);
  return String(month >= release ? year - 1 : year - 2);
}

/** ['1992','1993', ...] 含首尾 */
function yearSpan(from, to) {
  const out = [];
  let cur = Number(from);
  const end = Number(to);
  while (cur && end && cur <= end && out.length < 300) {
    out.push(String(cur));
    cur += 1;
  }
  return out;
}

/** 最新缓存年度是否滞后于应发布年度（前端 stale 标记用） */
function isStale(latest, expected) {
  if (!latest) return true;
  return String(latest) < String(expected || '');
}

/** 期别之间相差几年，用于「落后 3 年以上」判断 */
function gapOf(latest, expected) {
  if (!latest || !expected) return 99;
  if (latest >= expected) return 0;
  return Number(expected) - Number(latest);
}

module.exports = {
  COOLDOWN_MS,
  TRY_INTERVAL_MS,
  isYear,
  currentYear,
  expectedYear,
  yearSpan,
  isStale,
  gapOf,
};
