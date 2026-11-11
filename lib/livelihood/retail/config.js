'use strict';

/**
 * 社会消费品零售（民生子模块）配置装载与校验
 *
 * config/retail.json 是唯一事实来源：
 *   source     —— 前端展示的数据来源与口径说明
 *   history    —— 历史起点（2015-01，与其它民生模块一致）
 *   site       —— 国家数据月度库的接口前缀与 rootId
 *   catalogs   —— 要拉的栏目（一次请求拉一个栏目的全部指标），frozen 表示上游已停更
 *   groups     —— 明细表 / 图表分组
 *   indicators —— 展示指标：catalog + indicatorId 取原值，derive 表示本页计算量
 *
 * 指标编码全部由 probe 脚本实测得出（见 README「模块七：社会消费品零售」），
 * 改版面只动这个 JSON；取数走本目录 source.js，限流复用父目录 ../queue。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'retail.json');

/** 允许的计算口径（服务层按这些名字现算，不落盘） */
const DERIVES = ['ex_car', 'ex_car_yoy', 'online_share', 'rural_share'];

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
    throw new Error('config/retail.json 不是合法 JSON：' + e.message);
  }
  validate(json);
  cache = json;
  return cache;
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
    ['from', 'to'].forEach((k) => {
      if (cat && cat[k] && !MONTH.test(cat[k])) problems.push(who + ' ' + k + ' 必须是月份');
    });
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

    if (ind && ind.derive) {
      if (DERIVES.indexOf(ind.derive) === -1) problems.push(who + ' 未知计算口径: ' + ind.derive);
      if (!Array.isArray(ind.inputs) || !ind.inputs.length) problems.push(who + ' 计算量缺少 inputs');
      if (ind.catalog || ind.indicatorId) problems.push(who + ' 计算量不应再写 catalog / indicatorId');
    } else if (ind) {
      if (!ind.catalog) problems.push(who + ' 缺少 catalog');
      else if (!catIds.has(ind.catalog)) problems.push(who + ' 引用了不存在的 catalog: ' + ind.catalog);
      if (!HEX32.test(ind.indicatorId || '')) {
        problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe 脚本探测得出）');
      }
    }
    if (ind && ind.skipMonths && !Array.isArray(ind.skipMonths)) {
      problems.push(who + ' skipMonths 必须是月份数组');
    }
  });

  // 计算量的 inputs 必须指向已声明的指标
  const allIds = new Set(((json && json.indicators) || []).map((x) => x && x.id));
  ((json && json.indicators) || []).forEach((ind) => {
    ((ind && ind.inputs) || []).forEach((dep) => {
      if (!allIds.has(dep)) problems.push((ind.id || '?') + ' 的 inputs 引用了不存在的指标: ' + dep);
    });
  });

  if (problems.length) throw new Error('社会消费品零售指标配置有误：\n  - ' + problems.join('\n  - '));
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

function historyRange() {
  const h = load().history || {};
  return { from: h.from || '2015-01', to: '' };
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
  historyRange,
  site,
  settings,
  reset,
  DERIVES,
  ROOT,
  CONFIG_FILE,
};
