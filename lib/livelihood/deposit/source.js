'use strict';

/**
 * 数据源 A：中国人民银行 · 调查统计司「金融机构信贷收支统计」
 *
 * 取数路径（全部是普通网页，不是接口）：
 *   /diaochatongjisi/116219/index.html                 调查统计司栏目页（列「XXXX年统计数据」）
 *   …/116319/2026ntjsj/index.html                      年份页（列各张统计表入口）
 *   …/jrjgxdsztj/index.html                            「金融机构信贷收支统计」子页
 *   …/attachDir/2026/10/2026101417461893946.htm        当年《金融机构人民币信贷收支表》
 *
 * 每个年份页都把当年所有表以 htm / xlsx / pdf 三件套附件发布，我们只要 htm。
 * 第 5 个 htm 是「金融机构人民币信贷收支表」（前 4 个是本外币 / 外汇 / 存款类机构），
 * 但表序会随年份变化，所以这里不写死下标：先试第 5 个，标题不匹配再顺次扫描其余附件。
 *
 * 表结构：一行「1.住户存款 /（1）活期存款 /（2）定期及其他存款」，一列一个月，
 * 表头形如 2026.01；未发布的月份是空单元格。网页是 GBK 编码。
 *
 * 数据源 B：人均存款的分母「年末总人口」走国家数据年度库，复用父目录的取数通道。
 *
 * 所有请求经父目录 queue 串行 + 1.2 秒间隔；失败一律抛错交给上层回退缓存。
 */

const config = require('./config');
const nbs = require('../source');
const { serialize, gate, sleep } = require('../queue');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 两次对外请求的最小间隔；央行站点连续请求会直接断连 */
const GAP_MS = 1200;
const TIMEOUT_MS = 30000;
const RETRIES = 2;
/** 进程内页面结构缓存（栏目页 / 年份页 / 附件清单在一天内不会变） */
const MEMO_TTL_MS = 10 * 60 * 1000;
/** 已知表序：第 5 个 htm 是人民币信贷收支表（仅作首选，命中后再校验标题） */
const PREFERRED_INDEX = 4;

function site() {
  return config.site();
}

function abs(href) {
  const base = String(site().baseUrl || '').replace(/\/$/, '');
  if (/^https?:/i.test(href)) return href;
  return base + (href.charAt(0) === '/' ? '' : '/') + href;
}

/** 央行附件是 GBK，先按 UTF-8 解，出现替换符再回退 GBK */
function decode(buf) {
  const utf8 = buf.toString('utf8');
  if (utf8.indexOf('\uFFFD') === -1) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return utf8;
  }
}

async function requestText(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error('请求超时（' + Math.round(TIMEOUT_MS / 1000) + 's）：' + target)),
    TIMEOUT_MS
  );
  try {
    const res = await fetch(abs(target), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: abs(site().hub || '/'),
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) throw new Error('HTTP ' + res.status + ' ' + target);
    return decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(label, task) {
  let lastErr = null;
  for (let i = 0; i <= RETRIES; i += 1) {
    try {
      return await serialize(async () => {
        await gate(GAP_MS);
        return task();
      });
    } catch (e) {
      lastErr = e;
      if (i < RETRIES) await sleep(3000 * (i + 1));
    }
  }
  throw new Error(label + ' 失败：' + (lastErr && lastErr.message ? lastErr.message : '未知错误'));
}

const memoStore = new Map();

async function memo(key, task) {
  const hit = memoStore.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;
  const value = await task();
  memoStore.set(key, { at: Date.now(), value: value });
  return value;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 页面里的链接（只取 <a href>，文本已去标签） */
function linksOf(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    out.push({ href: m[1], text: stripTags(m[2]) });
  }
  return out;
}

/** 把 HTML 表格拆成二维文本（不做任何列假设） */
function rowsOf(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(String(html || '')))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1]))) {
      cells.push(
        stripTags(td[1])
          .replace(/&nbsp;/g, ' ')
          .trim()
      );
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** 年份页清单：{ '2026': '/diaochatongjisi/116219/116319/2026ntjsj/index.html' } */
async function yearPages() {
  return memo('years', async () => {
    const html = await withRetry('读取调查统计司栏目页', () => requestText(site().hub));
    const out = {};
    linksOf(html).forEach((l) => {
      const m = new RegExp('^(\\d{4})' + site().yearLinkText + '$').exec(l.text.replace(/\s+/g, ''));
      if (m && !out[m[1]]) out[m[1]] = l.href;
    });
    if (!Object.keys(out).length) {
      throw new Error('调查统计司栏目页没有找到「XXXX' + site().yearLinkText + '」链接（站点可能改版）');
    }
    return out;
  });
}

/** 某年的「金融机构信贷收支统计」子页地址 */
async function creditPage(year) {
  const years = await yearPages();
  const href = years[String(year)];
  if (!href) {
    const e = new Error('上游没有 ' + year + ' 年统计数据页');
    e.noYear = true;
    throw e;
  }
  return memo('credit:' + year, async () => {
    const html = await withRetry('读取 ' + year + ' 年统计数据页', () => requestText(href));
    const hit = linksOf(html).filter((l) => l.text.indexOf(site().creditLinkText) !== -1)[0];
    if (!hit) throw new Error(year + ' 年统计数据页没有「' + site().creditLinkText + '」入口（站点可能改版）');
    return hit.href;
  });
}

/** 子页下的 htm 附件清单（按页面顺序，就是表的顺序） */
async function attachments(subHref) {
  return memo('att:' + subHref, async () => {
    const html = await withRetry('读取信贷收支统计子页', () => requestText(subHref));
    const seen = {};
    const out = [];
    linksOf(html).forEach((l) => {
      if (!/\.htm$/i.test(l.href) || !/attachDir/i.test(l.href)) return;
      if (seen[l.href]) return;
      seen[l.href] = true;
      out.push(l.href);
    });
    if (!out.length) throw new Error('信贷收支统计子页没有 htm 附件（站点可能改版）');
    return out;
  });
}

/** 页面标题是不是「金融机构人民币信贷收支表」（排除存款类机构 / 中资银行等同名变体） */
function titleMatches(html) {
  const s = site();
  const text = stripTags(html);
  const title = String(s.tableTitle || '');
  const excludes = s.tableExclude || [];
  if (!title) return false;
  let at = text.indexOf(title);
  while (at !== -1) {
    const before = text.slice(Math.max(0, at - 12), at);
    const excluded = excludes.some((w) => w && before.indexOf(w) !== -1);
    if (!excluded) return true;
    at = text.indexOf(title, at + title.length);
  }
  return false;
}

/** 表头里的月份列：[{ index, month }]，month 为 '01'..'12' */
function monthColumns(rows) {
  for (const cells of rows) {
    const cols = [];
    cells.forEach((text, index) => {
      const m = /^(\d{4})[.\-年](\d{1,2})月?$/.exec(String(text || '').replace(/\s+/g, ''));
      if (!m) return;
      const month = Number(m[2]);
      if (month < 1 || month > 12) return;
      cols.push({ index: index, month: month < 10 ? '0' + month : String(month) });
    });
    if (cols.length >= 6) return cols;
  }
  return [];
}

function cellValue(cells, index) {
  const raw = String(cells[index] === undefined || cells[index] === null ? '' : cells[index])
    .replace(/[,，\s\u3000]/g, '');
  if (!raw || raw === '-' || raw === '—' || raw === '…' || raw === '...') return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

function rowOf(rows, keyword, numbered) {
  for (const cells of rows) {
    const label = String(cells[0] || '');
    if (label.indexOf(keyword) === -1) continue;
    if (numbered && !/^1[.．、]/.test(label)) continue;
    return cells;
  }
  return null;
}

/** 解析一张表：{ months: { '01': {balance, demand, time} }, title } */
function parseDeposit(rows) {
  const s = site();
  const cols = monthColumns(rows);
  if (!cols.length) throw new Error('表头里找不到月份列（格式可能变化）');

  const balanceRow = rowOf(rows, s.rowBalance, true) || rowOf(rows, s.rowBalance, false);
  if (!balanceRow) throw new Error('表里找不到「' + s.rowBalance + '」行');
  const demandRow = rowOf(rows, s.rowDemand, false);
  const timeRow = rowOf(rows, s.rowTime, false);

  const months = {};
  cols.forEach((c) => {
    const balance = cellValue(balanceRow, c.index);
    if (balance === null) return; // 未发布的月份是空格子：跳过，不写 0
    months[c.month] = {
      balance: balance,
      demand: demandRow ? cellValue(demandRow, c.index) : null,
      time: timeRow ? cellValue(timeRow, c.index) : null,
    };
  });

  return { months: months, title: String((rows[0] || []).join(' ')).slice(0, 80) };
}

/**
 * 取某一年的住户存款（12 个月列，未发布月份不出现在结果里）
 * @returns {Promise<{year:string, months:Object, source:Object}>}
 */
async function fetchYear(year) {
  const subHref = await creditPage(year);
  const list = await attachments(subHref);

  const order = [];
  if (list[PREFERRED_INDEX]) order.push(PREFERRED_INDEX);
  for (let i = 0; i < list.length; i += 1) {
    if (i !== PREFERRED_INDEX) order.push(i);
  }

  const problems = [];
  for (const idx of order) {
    const href = list[idx];
    let html;
    try {
      html = await withRetry('读取 ' + year + ' 年信贷收支表', () => requestText(href));
    } catch (e) {
      problems.push(href + '：' + e.message);
      continue;
    }
    if (!titleMatches(html)) {
      problems.push(href + '：不是「' + site().tableTitle + '」');
      continue;
    }
    let parsed;
    try {
      parsed = parseDeposit(rowsOf(html));
    } catch (e) {
      problems.push(href + '：' + e.message);
      continue;
    }
    if (!Object.keys(parsed.months).length) {
      problems.push(href + '：没有解析出住户存款数值');
      continue;
    }
    return {
      year: String(year),
      months: parsed.months,
      source: { url: abs(href), title: parsed.title, fetchedAt: new Date().toISOString() },
    };
  }

  throw new Error(year + ' 年信贷收支表解析失败：' + problems.join('；').slice(0, 400));
}

/**
 * 人均存款的分母：国家数据年度库「年末总人口」（万人）
 * @returns {Promise<{years:Object, source:string, fetchedAt:string}>}
 */
async function fetchPopulation(fromYear, toYear) {
  const pop = config.population();
  const data = await nbs.fetchRange({
    catalogId: pop.catalog,
    indicatorIds: [pop.indicatorId],
    from: String(fromYear),
    to: String(toYear),
  });
  const map = (data && data[pop.indicatorId]) || {};
  const years = {};
  Object.keys(map).forEach((y) => {
    const n = Number(map[y]);
    if (isFinite(n) && n > 0) years[y] = n;
  });
  if (!Object.keys(years).length) throw new Error('年末总人口上游没有返回数值');
  return { years: years, source: pop.source || 'nbs', fetchedAt: new Date().toISOString() };
}

module.exports = {
  name: 'pbc',
  label: '中国人民银行 · 调查统计司',
  GAP_MS,
  abs,
  linksOf,
  rowsOf,
  yearPages,
  creditPage,
  attachments,
  parseDeposit,
  titleMatches,
  fetchYear,
  fetchPopulation,
};
