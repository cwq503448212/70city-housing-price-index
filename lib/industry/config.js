'use strict';

/**
 * 行业运行（工业 41 个大类行业 + PMI 分项）配置装载与校验
 *
 * config/industry.json 是唯一事实来源：
 *   source     —— 前端展示的数据来源与口径说明
 *   history    —— 历史起点（2018-01，工业分大类行业增加值栏目的起点）
 *   site       —— 国家数据月度库的接口前缀与 rootId
 *   catalogs   —— 要拉的栏目（一个栏目一次请求拉全），release 是发布日规则
 *   groups     —— 行业分组（采矿业 / 消费品 / 原材料 / 装备 / 公用 / 其他）与 PMI
 *   metrics    —— 每个行业的三条口径（增加值 / 营收 / 利润）的公共属性
 *   industries —— 41 个大类行业：短名、分组、三条序列的指标编码
 *   pmi        —— 10 个 PMI 分项（制造业 6 + 非制造业 4）
 *
 * 配置里 industry 只写一次编码，这里展开成统一的指标列表
 * （id = 行业 key + '.' + 口径 key，如 coal.profit），
 * 服务层的 describe / series / 单序列接口都基于这份展开结果，不再区分行业与 PMI。
 *
 * 指标编码全部由 probe 脚本实测得出（见 README「模块十：工业行业运行」），
 * 改版面只动 JSON；取数走本目录 source.js，限流在本目录内（不跨模块 require）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'industry.json');

const HEX32 = /^[0-9a-f]{32}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/industry.json 不是合法 JSON：' + e.message);
  }
  validate(json);
  cache = {
    raw: json,
    indicators: expand(json),
  };
  return cache;
}

/** release 只能是 { day: 1-31 } 或 { day: 'eom' } */
function isRelease(rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.day === 'eom') return true;
  const d = Number(rule.day);
  return Number.isInteger(d) && d >= 1 && d <= 31;
}

function validate(json) {
  const problems = [];
  if (!json || typeof json !== 'object') problems.push('根节点不是对象');

  const history = (json && json.history) || {};
  if (!MONTH.test(history.from || '')) problems.push('history.from 必须是月份（YYYY-MM）');

  const site = (json && json.site) || {};
  if (!site.baseUrl) problems.push('site.baseUrl 不能为空');
  if (!site.ext) problems.push('site.ext 不能为空');
  if (!HEX32.test(site.rootId || '')) {
    problems.push('site.rootId 必须是 32 位编码（必须由 probe 脚本探测得出）');
  }

  const catalogs = (json && json.catalogs) || [];
  if (!catalogs.length) problems.push('catalogs 不能为空');
  const catIds = new Set();
  catalogs.forEach((cat, i) => {
    const who = cat && cat.id ? cat.id : 'catalogs#' + i;
    if (!cat || !cat.id) problems.push(who + ' 缺少 id');
    if (cat && catIds.has(cat.id)) problems.push(who + ' id 重复');
    if (cat && cat.id) catIds.add(cat.id);
    if (!cat || !cat.label) problems.push(who + ' 缺少 label');
    if (!HEX32.test((cat && cat.catalogId) || '')) {
      problems.push(who + ' catalogId 必须是 32 位编码（必须由 probe 脚本探测得出）');
    }
    if (!isRelease(cat && cat.release)) problems.push(who + ' release 必须是 { day: 1-31 } 或 { day: "eom" }');
  });

  const groups = new Set(((json && json.groups) || []).map((g) => g && g.key));
  if (!groups.has('pmi')) problems.push('groups 里必须有 pmi 分组');

  const metrics = (json && json.metrics) || [];
  if (!metrics.length) problems.push('metrics 不能为空');
  const metricKeys = new Set();
  metrics.forEach((m) => {
    const who = 'metrics.' + ((m && m.key) || '?');
    if (!m || !m.key) problems.push(who + ' 缺少 key');
    if (m && metricKeys.has(m.key)) problems.push(who + ' key 重复');
    if (m && m.key) metricKeys.add(m.key);
    if (!m || !m.label) problems.push(who + ' 缺少 label');
    if (!m || !m.unit) problems.push(who + ' 缺少 unit');
    if (!m || !m.kind) problems.push(who + ' 缺少 kind');
    if (!m || !catIds.has(m.catalog)) problems.push(who + ' 引用了不存在的 catalog: ' + (m && m.catalog));
    if (m && m.skipMonths && !Array.isArray(m.skipMonths)) problems.push(who + ' skipMonths 必须是月份数组');
  });

  const industries = (json && json.industries) || [];
  if (!industries.length) problems.push('industries 不能为空');
  const seenKeys = new Set();
  industries.forEach((ind, i) => {
    const who = ind && ind.key ? ind.key : 'industries#' + i;
    if (!ind || !ind.key) problems.push(who + ' 缺少 key');
    if (ind && seenKeys.has(ind.key)) problems.push(who + ' key 重复');
    if (ind && ind.key) seenKeys.add(ind.key);
    if (!ind || !ind.label) problems.push(who + ' 缺少 label');
    if (!ind || !ind.shortLabel) problems.push(who + ' 缺少 shortLabel');
    if (!ind || !groups.has(ind.group)) problems.push(who + ' 引用了不存在的 group: ' + (ind && ind.group));
    metrics.forEach((m) => {
      if (!HEX32.test((ind && ind[m.key]) || '')) {
        problems.push(who + ' 的 ' + m.key + ' 必须是 32 位编码（必须由 probe 脚本探测得出）');
      }
    });
  });

  const pmi = (json && json.pmi) || [];
  if (!pmi.length) problems.push('pmi 不能为空');
  const seenPmi = new Set();
  pmi.forEach((p, i) => {
    const who = p && p.id ? p.id : 'pmi#' + i;
    if (!p || !p.id) problems.push(who + ' 缺少 id');
    if (p && seenPmi.has(p.id)) problems.push(who + ' id 重复');
    if (p && seenPmi.has(p.id)) problems.push(who + ' id 与其它 PMI 分项重复');
    if (p && p.id) seenPmi.add(p.id);
    if (!p || !p.label) problems.push(who + ' 缺少 label');
    if (!p || !catIds.has(p.catalog)) problems.push(who + ' 引用了不存在的 catalog: ' + (p && p.catalog));
    if (!HEX32.test((p && p.indicatorId) || '')) {
      problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe 脚本探测得出）');
    }
    if (p && seenKeys.has(p.id)) problems.push(who + ' id 与某个行业 key 冲突');
  });

  if (problems.length) throw new Error('行业运行指标配置有误：\n  - ' + problems.join('\n  - '));
}

/** 行业（每条 3 个口径）+ PMI 分项 → 统一指标列表 */
function expand(json) {
  const out = [];
  const history = (json.history || {}).from;
  const metrics = json.metrics || [];

  (json.industries || []).forEach((ind) => {
    metrics.forEach((m) => {
      out.push({
        id: ind.key + '.' + m.key,
        label: ind.label + ' · ' + m.label,
        shortLabel: ind.shortLabel + ' ' + m.label,
        unit: m.unit,
        kind: m.kind,
        group: ind.group,
        decimals: typeof m.decimals === 'number' ? m.decimals : 1,
        note: m.note || '',
        catalog: m.catalog,
        indicatorId: ind[m.key],
        skipMonths: m.skipMonths || [],
        industry: ind.key,
        industryLabel: ind.label,
        industryShort: ind.shortLabel,
        metric: m.key,
        historyFrom: history,
      });
    });
  });

  (json.pmi || []).forEach((p) => {
    out.push({
      id: p.id,
      label: p.label,
      shortLabel: p.shortLabel || p.label,
      unit: '%',
      kind: 'index_pmi',
      group: 'pmi',
      decimals: 1,
      note: p.note || '',
      catalog: p.catalog,
      indicatorId: p.indicatorId,
      skipMonths: [],
      industry: '',
      industryLabel: '',
      industryShort: '',
      metric: 'pmi',
      historyFrom: history,
    });
  });

  return out;
}

function list() {
  return load().indicators;
}

// 客户端传了不存在的 id 属于「请求错误」，不是服务端故障 → 带 status=404
function byId(id) {
  const found = list().filter((x) => x.id === id)[0];
  if (!found) {
    const e = new Error('未知指标: ' + id);
    e.status = 404;
    throw e;
  }
  return found;
}

function catalogs() {
  return load().raw.catalogs;
}

function catalogOf(id) {
  const found = catalogs().filter((x) => x.id === id)[0];
  if (!found) throw new Error('配置里没有栏目 ' + id);
  return found;
}

/** 行业清单（含分组与短名，前端画矩阵与排行用） */
function industries() {
  return load().raw.industries;
}

function metrics() {
  return load().raw.metrics;
}

function pmiList() {
  return load().raw.pmi;
}

/** 某个行业的三条指标（增加值 / 营收 / 利润） */
function indicatorsOfIndustry(key) {
  return list().filter((x) => x.industry === key);
}

function historyRange() {
  const h = load().raw.history || {};
  return { from: h.from || '2018-01', to: '' };
}

function site() {
  return load().raw.site || {};
}

function settings() {
  const c = load().raw;
  return {
    history: historyRange(),
    groups: c.groups || [],
    metrics: c.metrics || [],
    source: c.source || {},
    rootLabel: (c.source && c.source.label) || '国家统计局 · 国家数据',
  };
}

function reset() {
  cache = null;
}

module.exports = {
  load,
  list,
  byId,
  catalogs,
  catalogOf,
  industries,
  metrics,
  pmiList,
  indicatorsOfIndustry,
  historyRange,
  site,
  settings,
  reset,
  ROOT,
  CONFIG_FILE,
};
