'use strict';

/**
 * 拉取判定策略（全项目唯一出口，前端不自己算月份）
 *
 * 只有三种情况允许发起远端请求：
 *   1. 该统计月还没有缓存；
 *   2. 现在已过该指标的发布日，而缓存里最新期别还早于「应发布期别」；
 *   3. 用户手动刷新。
 * 其余一律直接读缓存。
 *
 * 发布日规则写在 config/indicators.json 的 release 字段：
 *   { "day": 9 }     每月 9 日发布上月数据（CPI / PPI）
 *   { "day": 15 }    每月 15 日（社零 / M2 的常规节奏）
 *   { "day": "eom" } 当月最后一天（PMI）
 */

const month = require('../util/month');

const COOLDOWN_MS = 60 * 1000;
/**
 * 同一指标两次回源尝试的最小间隔。
 * 与 COOLDOWN_MS 的区别：这个时间落在 meta.lastAttempt 里，进程重启后仍然生效，
 * 避免每次冷启动都把「上游还没更新」的指标重新请求一遍（那是首屏变慢的主因）。
 */
const TRY_INTERVAL_MS = 10 * 60 * 1000;

/** 统计月 month 的发布时刻（本地时间 09:30） */
function publishDate(monthStr, release) {
  const p = month.parseMonth(monthStr);
  const rule = release || {};
  if (rule.day === 'eom') {
    return new Date(p.year, p.month - 1, month.daysInMonth(monthStr), 9, 30, 0);
  }
  const day = Number(rule.day || 9);
  // 下个月的第 day 天
  const next = month.addMonths(monthStr, 1);
  const np = month.parseMonth(next);
  const safeDay = Math.min(day, month.daysInMonth(next));
  return new Date(np.year, np.month - 1, safeDay, 9, 30, 0);
}

/** 截至 now，最晚应该已经发布的统计月 */
function expectedLatestMonth(release, now) {
  const ref = now || new Date();
  const cur = month.currentMonth(ref);
  for (let i = 0; i <= 4; i += 1) {
    const candidate = month.addMonths(cur, -i);
    if (publishDate(candidate, release) <= ref) return candidate;
  }
  return month.addMonths(cur, -4);
}

/**
 * 该不该发起请求
 * @param {object} p
 * @param {string[]} p.cachedMonths 已缓存月份（升序）
 * @param {object} p.release
 * @param {string} p.wantFrom 需要的起始月份
 * @param {string[]} [p.exempt] 本身就不发布的月份（如社零当月值的 1 月），不计入缺失
 * @param {Date} [p.now]
 * @param {boolean} [p.force]
 * @returns {{fetch:boolean, reason:string, expectedLatest:string, from:string, latestCached:string}}
 */
function shouldFetch(p) {
  const cached = p.cachedMonths || [];
  const expectedLatest = expectedLatestMonth(p.release, p.now);
  const latestCached = cached.length ? cached[cached.length - 1] : '';
  const wantFrom = p.wantFrom || expectedLatest;

  if (p.force) {
    return { fetch: true, reason: '手动刷新', expectedLatest, from: wantFrom, latestCached };
  }
  if (!cached.length) {
    return { fetch: true, reason: '无缓存', expectedLatest, from: wantFrom, latestCached };
  }

  const needed = month.range(wantFrom, expectedLatest);
  const exempt = p.exempt || [];
  const missing = needed.filter((m) => cached.indexOf(m) === -1 && exempt.indexOf(m.slice(5)) === -1);
  if (missing.length) {
    return {
      fetch: true,
      reason: '存在未缓存期别（' + missing.length + ' 个月）',
      expectedLatest,
      from: missing[0] < wantFrom ? wantFrom : missing[0],
      latestCached,
    };
  }

  if (latestCached < expectedLatest) {
    return { fetch: true, reason: '已过发布日，缓存期别滞后', expectedLatest, from: wantFrom, latestCached };
  }

  return { fetch: false, reason: '缓存有效', expectedLatest, from: wantFrom, latestCached };
}

/** 数据是否「可能滞后」（用于前端 stale 标记） */
function isStale(cachedMonths, release, now) {
  const cached = cachedMonths || [];
  if (!cached.length) return true;
  return cached[cached.length - 1] < expectedLatestMonth(release, now);
}

module.exports = { COOLDOWN_MS, TRY_INTERVAL_MS, publishDate, expectedLatestMonth, shouldFetch, isStale };
