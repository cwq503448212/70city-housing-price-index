'use strict';

/**
 * 养老医保（民生子模块）配置装载与校验
 *
 * config/security.json 是唯一事实来源：
 *   source     —— 前端展示的数据来源与「为什么不解析人社部 / 医保局公报正文」
 *   site       —— 国家数据年度库的站点参数（rootId 必须是年度库）
 *   history    —— 历史起点（年度，'YYYY'）
 *   catalogs   —— 年度库栏目：id / catalogId / from / releaseMonth
 *   groups     —— 图表与明细表分组
 *   indicators —— 展示指标：catalog + indicatorId 取原值，derive 表示本页计算量，
 *                 until 表示官方已停更的截止期别（归档，不再回源），
 *                 from 收窄单条指标自己的起点（口径发生整合的序列用得上）
 *
 * 指标编码全部由 probe.js 实测得出（见 README「模块九：养老医保」），
 * 改版面只动这个 JSON；取数复用父目录 ../source（同一年度库），限流复用 ../queue。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'security.json');

/**
 * 允许的计算口径（服务层按这些名字现算，不落盘）
 *   diff        a − b
 *   ratio_pct   a ÷ b × 100
 *   months      a ÷ (b ÷ 12)      累计结余能覆盖几个月的支出
 *   per_capita  a(亿元) × 1e8 ÷ (b(万人) × 1e4)   → 元/人
 */
const DERIVES = ['diff', 'ratio_pct', 'months', 'per_capita'];

const HEX32 = /^[0-9a-f]{32}$/;
const YEAR = /^\d{4}$/;

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/security.json 不是合法 JSON：' + e.message);
  }
  validate(json);
  cache = json;
  return cache;
}

function validate(json) {
  const problems = [];
  if (!json || typeof json !== 'object') problems.push('根节点不是对象');

  const history = (json && json.history) || {};
  if (!YEAR.test(history.from || '')) problems.push('history.from 必须是年份（YYYY）');

  const site = (json && json.site) || {};
  if (!site.baseUrl) problems.push('site.baseUrl 不能为空');
  if (!site.ext) problems.push('site.ext 不能为空');
  if (!HEX32.test(site.rootId || '')) problems.push('site.rootId 必须是 32 位编码（年度库根节点）');

  const catalogs = (json && json.catalogs) || [];
  if (!catalogs.length) problems.push('catalogs 不能为空');
  const catMap = new Map();
  catalogs.forEach((cat, i) => {
    const who = cat && cat.id ? cat.id : 'catalogs#' + i;
    if (!cat || !cat.id) problems.push(who + ' 缺少 id');
    if (cat && catMap.has(cat.id)) problems.push(who + ' id 重复');
    if (cat && cat.id) catMap.set(cat.id, cat);
    if (!cat || !cat.label) problems.push(who + ' 缺少 label');
    if (!HEX32.test((cat && cat.catalogId) || '')) {
      problems.push(who + ' catalogId 必须是 32 位编码（必须由 probe.js 探测得出）');
    }
    if (cat && cat.from && !YEAR.test(cat.from)) problems.push(who + ' from 必须是年份（YYYY）');
    if (cat && cat.to && !YEAR.test(cat.to)) problems.push(who + ' to 必须是年份（YYYY）');
    if (cat && cat.releaseMonth !== undefined) {
      const m = Number(cat.releaseMonth);
      if (!(m >= 1 && m <= 12)) problems.push(who + ' releaseMonth 必须是 1—12 的月份');
    }
  });

  const groups = new Set(((json && json.groups) || []).map((g) => g && g.key));
  const seen = new Set();
  ((json && json.indicators) || []).forEach((ind, i) => {
    const who = ind && ind.id ? ind.id : '#' + i;
    if (!ind || !ind.id) problems.push(who + ' 缺少 id');
    if (ind && seen.has(ind.id)) problems.push(who + ' id 重复');
    if (ind && ind.id) seen.add(ind.id);
    if (!ind || !ind.label) problems.push(who + ' 缺少 label');
    if (!ind || !ind.unit) problems.push(who + ' 缺少 unit');
    if (!ind || !ind.kind) problems.push(who + ' 缺少 kind');
    if (!ind || !ind.group) problems.push(who + ' 缺少 group');
    else if (!groups.has(ind.group)) problems.push(who + ' 引用了不存在的 group: ' + ind.group);

    const cat = ind && ind.catalog ? catMap.get(ind.catalog) : null;
    if (ind && ind.derive) {
      if (DERIVES.indexOf(ind.derive) === -1) problems.push(who + ' 未知计算口径: ' + ind.derive);
      if (!Array.isArray(ind.inputs) || ind.inputs.length !== 2) {
        problems.push(who + ' 计算量必须正好两个 inputs（a op b）');
      }
      if (ind.catalog || ind.indicatorId) problems.push(who + ' 计算量不应再写 catalog / indicatorId');
      if (ind.until) problems.push(who + ' 计算量不应写 until（有效期跟着输入指标走）');
    } else if (ind) {
      if (!ind.catalog) problems.push(who + ' 缺少 catalog');
      else if (!cat) problems.push(who + ' 引用了不存在的 catalog: ' + ind.catalog);
      if (!HEX32.test(ind.indicatorId || '')) {
        problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe.js 探测得出）');
      }
    }

    if (ind && ind.from && !YEAR.test(ind.from)) problems.push(who + ' from 必须是年份（YYYY）');
    if (ind && ind.until && !YEAR.test(ind.until)) problems.push(who + ' until 必须是年份（YYYY）');
    if (ind && ind.from && ind.until && ind.from > ind.until) problems.push(who + ' from 晚于 until');
  });

  // 计算量的 inputs 必须指向已声明的指标，且不能自引用 / 互相成环
  const list = (json && json.indicators) || [];
  const indMap = new Map(list.map((x) => [x && x.id, x]));
  list.forEach((ind) => {
    ((ind && ind.inputs) || []).forEach((dep) => {
      if (!indMap.has(dep)) problems.push((ind.id || '?') + ' 的 inputs 引用了不存在的指标: ' + dep);
      if (dep === (ind && ind.id)) problems.push((ind.id || '?') + ' 的 inputs 不能引用自己');
    });
  });

  if (problems.length) throw new Error('养老医保指标配置有误：\n  - ' + problems.join('\n  - '));
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
  return load().catalogs;
}

function catalogOf(id) {
  const found = catalogs().filter((x) => x.id === id)[0];
  if (!found) throw new Error('配置里没有栏目 ' + id);
  return found;
}

/** 某栏目名下已声明的原始指标（计算量不归任何栏目） */
function indicatorsOfCatalog(key) {
  return list().filter((ind) => ind.catalog === key && !ind.derive);
}

function historyRange() {
  const h = load().history || {};
  return { from: h.from || '1990', note: h.note || '' };
}

function site() {
  return load().site || {};
}

function settings() {
  const c = load();
  return {
    history: historyRange(),
    groups: c.groups || [],
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
  indicatorsOfCatalog,
  historyRange,
  site,
  settings,
  reset,
  DERIVES,
  ROOT,
  CONFIG_FILE,
};
