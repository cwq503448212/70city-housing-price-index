'use strict';

/**
 * 回源判定（本模块唯一出口，前端不自己算期别）
 *
 * 月度序列（城镇调查失业率 / 周平均工时）随「国民经济运行情况」每月 15 日左右发布上月值，
 * 所以「截至今天最晚应已发布」的月份是：
 *
 *   当天 >= 15 日 → 上个月（例：2026-11-20 → 2026-10）
 *   当天 <  15 日 → 上上个月（例：2026-11-10 → 2026-09；1 月初同理回退到上一年 11 月）
 *
 * 年度序列没有全国统一的发布日，按栏目各自的 releaseMonth 判断「上一年的数据从哪个月起算已发布」：
 *
 *   月份 >= releaseMonth → 应发布上一年（农民工 4—5 月出调查报告，releaseMonth = 5；
 *                          登记失业随《中国统计年鉴》9—10 月入库，releaseMonth = 10）
 *   月份 <  releaseMonth → 仍是前一年（年报尚未入库）
 *
 * 官方已停更的指标（until，如 25—59 岁旧口径止于 2023-06、登记失业率止于 2021）
 * 永远按 until 判定：不标 stale、不再回源。
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该栏目还没有缓存；
 *   2. 该栏目缓存的最新期别早于它名下指标应发布的期别；
 *   3. 用户手动刷新。
 */

const COOLDOWN_MS = 60 * 1000;
/** 两次回源尝试的最小间隔，落在 _meta.json 的 lastAttempt 里，进程重启后仍生效 */
const TRY_INTERVAL_MS = 10 * 60 * 1000;

const MONTH = /^(\d{4})-(\d{2})$/;
const YEAR = /^\d{4}$/;

/** 期别平移：('2026-01', -1) → '2025-12'；('2026', -1) → '2025' */
function shift(period, delta) {
  if (YEAR.test(String(period || ''))) return String(Number(period) + Number(delta));
  const m = MONTH.exec(String(period || ''));
  if (!m) return '';
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Number(delta);
  const y = Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12 + 1;
  return String(y) + '-' + (mo < 10 ? '0' : '') + mo;
}

function addMonths(key, delta) {
  return shift(key, delta);
}

function monthKey(date) {
  const d = date || new Date();
  const mo = d.getMonth() + 1;
  return String(d.getFullYear()) + '-' + (mo < 10 ? '0' : '') + mo;
}

/** 截至 now 最晚应已发布的月份（调查失业率随月度运行情况发布） */
function expectedMonth(now) {
  const ref = now || new Date();
  return shift(monthKey(ref), ref.getDate() >= 15 ? -1 : -2);
}

/** 年度栏目的应发布年度（按栏目自己的 releaseMonth） */
function expectedYear(catalog, now) {
  const ref = now || new Date();
  const year = ref.getFullYear();
  const month = ref.getMonth() + 1;
  const release = Number((catalog && catalog.releaseMonth) || 3);
  return String(month >= release ? year - 1 : year - 2);
}

/**
 * 某个指标应发布到哪一期
 * @param {object} indicator 指标配置（含 freq / until）
 * @param {object} catalog 所属栏目（年度用它算 releaseMonth）
 * @param {Date} [now]
 */
function expectedFor(indicator, catalog, now) {
  if (!indicator) return '';
  if (indicator.until) return indicator.until;
  if (indicator.freq === 'year') return expectedYear(catalog, now);
  return expectedMonth(now);
}

/** 所有指标里最晚的应发布期别（决定该栏目要不要回源） */
function requiredFor(catalog, indicators, now) {
  let need = '';
  (indicators || []).forEach((ind) => {
    const e = expectedFor(ind, catalog, now);
    if (e > need) need = e;
  });
  if (need) return need;
  return catalog && catalog.freq === 'year' ? expectedYear(catalog, now) : expectedMonth(now);
}

/** ['2026-01','2026-02', ...] 含首尾 */
function monthSpan(from, to) {
  const out = [];
  let cur = from;
  while (cur && MONTH.test(cur) && cur <= to && out.length < 800) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

/** ['2013','2014', ...] 含首尾 */
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

/** 期别之间相差几期（月度按月、年度按年），用于「落后 3 期以上」判断 */
function gapOf(latest, expected, freq) {
  if (!latest || !expected) return 99;
  if (latest >= expected) return 0;
  if (freq === 'year') return Number(expected) - Number(latest);
  return monthSpan(latest, expected).length - 1;
}

module.exports = {
  COOLDOWN_MS,
  TRY_INTERVAL_MS,
  shift,
  addMonths,
  monthKey,
  expectedMonth,
  expectedYear,
  expectedFor,
  requiredFor,
  monthSpan,
  yearSpan,
  isStale,
  gapOf,
};
