'use strict';

/**
 * 月份工具（统计口径统一用 'YYYY-MM' 字符串，避免时区问题）
 */

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function parseMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) throw new Error('非法月份: ' + month);
  return { year: Number(m[1]), month: Number(m[2]) };
}

function formatMonth(year, month) {
  return year + '-' + pad(month);
}

function addMonths(month, delta) {
  const p = parseMonth(month);
  const total = p.year * 12 + (p.month - 1) + delta;
  const year = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return formatMonth(year, m);
}

function currentMonth(now) {
  const d = now || new Date();
  return formatMonth(d.getFullYear(), d.getMonth() + 1);
}

function lastDay(year, month) {
  return new Date(year, month, 0).getDate();
}

function daysInMonth(month) {
  const p = parseMonth(month);
  return lastDay(p.year, p.month);
}

/** ['2021-01','2021-02', ...] 含首尾 */
function range(from, to) {
  const out = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 1200) {
    out.push(cur);
    cur = addMonths(cur, 1);
    guard += 1;
  }
  return out;
}

/** 展示用：2026-10 → 2026年10月 */
function toCn(month) {
  const p = parseMonth(month);
  return p.year + '年' + p.month + '月';
}

/** 展示用（图轴）：2026-10 → 26/10 */
function toAxis(month) {
  const p = parseMonth(month);
  return String(p.year).slice(2) + '/' + pad(p.month);
}

module.exports = { parseMonth, formatMonth, addMonths, currentMonth, daysInMonth, range, toCn, toAxis, pad };
