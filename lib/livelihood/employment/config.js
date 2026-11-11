'use strict';

/**
 * 就业（民生子模块）配置装载与校验
 *
 * config/employment.json 是唯一事实来源：
 *   source     —— 前端展示的数据来源与口径说明
 *   site       —— 月度库 / 年度库两套 rootId（同一个站点、同一组内部接口）
 *   history    —— 两套历史起点：月度 2018-01（调查失业率起）、年度 1978（年度库起）
 *   catalogs   —— 栏目：freq 为 month / year，from 收紧该栏目的实际起点
 *   groups     —— 图表与明细表分组
 *   indicators —— 展示指标：catalog + indicatorId 取原值，derive 表示本页计算量，
 *                 until 表示官方已停更的截止期别（归档，不再回源）
 *
 * 指标编码全部由 probe.js 实测得出（见 README「模块八：就业」），
 * 改版面只动这个 JSON；取数走本目录 source.js，限流复用父目录 ../queue。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'employment.json');

/** 允许的计算口径（服务层按这些名字现算，不落盘） */
const DERIVES = ['gap_city', 'gap_youth', 'migrant_out_share'];

const HEX32 = /^[0-9a-f]{32}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;
const FREQS = ['month', 'year'];

/** 期别格式随频率走：月度 YYYY-MM，年度 YYYY */
function isPeriod(freq, v) {
  return freq === 'month' ? MONTH.test(v || '') : YEAR.test(v || '');
}

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/employment.json 不是合法 JSON：' + e.message);
  }
  validate(json);
  cache = json;
  return cache;
}

function validate(json) {
  const problems = [];
  if (!json || typeof json !== 'object') problems.push('根节点不是对象');

  const history = (json && json.history) || {};
  if (!MONTH.test(history.month || '')) problems.push('history.month 必须是月份（YYYY-MM）');
  if (!YEAR.test(history.year || '')) problems.push('history.year 必须是年份（YYYY）');

  const site = (json && json.site) || {};
  if (!site.baseUrl) problems.push('site.baseUrl 不能为空');
  if (!site.ext) problems.push('site.ext 不能为空');
  if (!HEX32.test(site.monthlyRootId || '')) problems.push('site.monthlyRootId 必须是 32 位编码');
  if (!HEX32.test(site.annualRootId || '')) problems.push('site.annualRootId 必须是 32 位编码');

  const catalogs = (json && json.catalogs) || [];
  if (!catalogs.length) problems.push('catalogs 不能为空');
  const catMap = new Map();
  catalogs.forEach((cat, i) => {
    const who = cat && cat.id ? cat.id : 'catalogs#' + i;
    if (!cat || !cat.id) problems.push(who + ' 缺少 id');
    if (cat && catMap.has(cat.id)) problems.push(who + ' id 重复');
    if (cat && cat.id) catMap.set(cat.id, cat);
    if (!cat || !cat.label) problems.push(who + ' 缺少 label');
    if (!cat || FREQS.indexOf(cat.freq) === -1) problems.push(who + ' freq 必须是 month / year');
    if (!HEX32.test((cat && cat.catalogId) || '')) {
      problems.push(who + ' catalogId 必须是 32 位编码（必须由 probe 脚本探测得出）');
    }
    if (cat && cat.from && !isPeriod(cat.freq, cat.from)) problems.push(who + ' from 期别格式不对');
    if (cat && cat.to && !isPeriod(cat.freq, cat.to)) problems.push(who + ' to 期别格式不对');
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
    if (!ind || FREQS.indexOf(ind.freq) === -1) problems.push(who + ' freq 必须是 month / year');

    const cat = ind && ind.catalog ? catMap.get(ind.catalog) : null;
    if (ind && ind.derive) {
      if (DERIVES.indexOf(ind.derive) === -1) problems.push(who + ' 未知计算口径: ' + ind.derive);
      if (!Array.isArray(ind.inputs) || !ind.inputs.length) problems.push(who + ' 计算量缺少 inputs');
      if (ind.catalog || ind.indicatorId) problems.push(who + ' 计算量不应再写 catalog / indicatorId');
      if (ind.until) problems.push(who + ' 计算量不应写 until（有效期跟着输入指标走）');
    } else if (ind) {
      if (!ind.catalog) problems.push(who + ' 缺少 catalog');
      else if (!cat) problems.push(who + ' 引用了不存在的 catalog: ' + ind.catalog);
      else if (cat.freq !== ind.freq) problems.push(who + ' freq 与栏目 ' + cat.id + ' 不一致');
      if (!HEX32.test(ind.indicatorId || '')) {
        problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe 脚本探测得出）');
      }
    }

    if (ind && ind.until && !isPeriod(ind.freq, ind.until)) problems.push(who + ' until 期别格式不对');
  });

  // 计算量的 inputs 必须指向已声明的指标，且频率一致（月度差值不能混进年度指标）
  const indMap = new Map(((json && json.indicators) || []).map((x) => [x && x.id, x]));
  ((json && json.indicators) || []).forEach((ind) => {
    ((ind && ind.inputs) || []).forEach((dep) => {
      const depInd = indMap.get(dep);
      if (!depInd) problems.push((ind.id || '?') + ' 的 inputs 引用了不存在的指标: ' + dep);
      else if (depInd.freq !== ind.freq) problems.push((ind.id || '?') + ' 的 inputs 频率与自身不一致: ' + dep);
    });
  });

  if (problems.length) throw new Error('就业指标配置有误：\n  - ' + problems.join('\n  - '));
}

function list() {
  return load().indicators;
}

function byFreq(freq) {
  return list().filter((x) => x.freq === freq);
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

/** 某栏目名下已声明的指标 */
function indicatorsOfCatalog(key) {
  return list().filter((ind) => ind.catalog === key);
}

function historyRange() {
  const h = load().history || {};
  return { month: h.month || '2018-01', year: h.year || '1978', note: h.note || '' };
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
  byFreq,
  byId,
  catalogs,
  catalogOf,
  indicatorsOfCatalog,
  historyRange,
  site,
  settings,
  reset,
  isPeriod,
  DERIVES,
  ROOT,
  CONFIG_FILE,
};
