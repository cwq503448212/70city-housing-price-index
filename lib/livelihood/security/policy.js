'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算期别）
 *
 * 全部是年度序列，没有月度发布日的概念，按栏目各自的 releaseMonth 判断
 * 「上一年的数据从哪个月起算已发布」：
 *
 *   月份 >= releaseMonth → 应发布上一年
 *   月份 <  releaseMonth → 仍是前一年（年报尚未入库）
 *
 * 社会保险各表随《中国统计年鉴》入库，近年多在次年 9—12 月才补齐，因此
 * releaseMonth 统一取 10：到 10 月还只有前一年，就说明这一期确实没入库，
 * 按 10 分钟冷却轻量重试，等上游补齐后自动收进来。
 *
 * 官方已停更的指标（until，如生育保险基金三项止于 2018）永远按 until 判定：
 * 不标 stale、不再回源。计算量的有效期跟着输入指标走（取最早的那个截止点）。
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该栏目还没有缓存；
 *   2. 该栏目缓存的最新期别早于它名下指标应发布的期别；
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

/** 年度栏目的应发布年度（按栏目自己的 releaseMonth） */
function expectedYear(catalog, now) {
  const ref = now || new Date();
  const year = ref.getFullYear();
  const month = ref.getMonth() + 1;
  const release = Number((catalog && catalog.releaseMonth) || 10);
  return String(month >= release ? year - 1 : year - 2);
}

/**
 * 某个指标应发布到哪一年
 * @param {object} indicator 指标配置（含 until / from）
 * @param {object} catalog 所属栏目（算 releaseMonth）
 * @param {Date} [now]
 */
function expectedFor(indicator, catalog, now) {
  if (!indicator) return '';
  if (indicator.until) return indicator.until;
  return expectedYear(catalog, now);
}

/** 所有指标里最晚的应发布年度（决定该栏目要不要回源） */
function requiredFor(catalog, indicators, now) {
  let need = '';
  (indicators || []).forEach((ind) => {
    const e = expectedFor(ind, catalog, now);
    if (e > need) need = e;
  });
  if (need) return need;
  return expectedYear(catalog, now);
}

/** ['2010','2011', ...] 含首尾 */
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

/** 最新缓存期别是否滞后于应发布期别（前端 stale 标记用） */
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
  expectedFor,
  requiredFor,
  yearSpan,
  isStale,
  gapOf,
};
