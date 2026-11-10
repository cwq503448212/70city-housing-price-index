'use strict';

/**
 * 居民存款与人均存款（民生子模块）配置装载与校验
 *
 * config/deposit.json 是唯一事实来源：
 *   source     —— 前端展示的数据来源与口径说明
 *   history    —— 历史起点（2015：央行「统计数据」年份页最早的一年）
 *   site       —— 央行站点的栏目路径、表名、行名（改版时只改这里）
 *   population —— 人均口径的分母：国家数据年度库「年末总人口」
 *   groups     —— 明细表分组
 *   indicators —— 展示指标；from 指向「原始量 / 计算量」，scale 负责单位折算
 *
 * 与人均收支子模块一样，这里只放配置：取数走本目录 source.js，
 * 年度人口走父目录 ../source，限流复用 ../queue。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'deposit.json');

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/deposit.json 不是合法 JSON：' + e.message);
  }
  validate(json);
  cache = json;
  return cache;
}

function validate(json) {
  const problems = [];
  if (!json || typeof json !== 'object') problems.push('根节点不是对象');

  const history = (json && json.history) || {};
  if (!/^\d{4}$/.test(history.from || '')) problems.push('history.from 必须是年份（YYYY）');

  const site = (json && json.site) || {};
  ['baseUrl', 'hub', 'yearLinkText', 'creditLinkText', 'tableTitle'].forEach((k) => {
    if (!site[k]) problems.push('site.' + k + ' 不能为空');
  });
  ['rowBalance', 'rowDemand', 'rowTime'].forEach((k) => {
    if (!site[k]) problems.push('site.' + k + ' 不能为空（表中行名）');
  });

  const pop = (json && json.population) || {};
  if (!/^[0-9a-f]{32}$/.test(pop.catalog || '')) {
    problems.push('population.catalog 必须是 32 位编码（必须由 probe.js 探测得出）');
  }
  if (!/^[0-9a-f]{32}$/.test(pop.indicatorId || '')) {
    problems.push('population.indicatorId 必须是 32 位编码（必须由 probe.js 探测得出）');
  }

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
    if (!ind || !ind.from) problems.push(who + ' 缺少 from（原始量名）');
    if (ind && typeof ind.scale !== 'number') problems.push(who + ' 缺少 scale（单位折算系数）');
  });

  if (problems.length) throw new Error('居民存款指标配置有误：\n  - ' + problems.join('\n  - '));
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

function historyRange() {
  const h = load().history || {};
  return { from: h.from || '2015', to: '' };
}

function site() {
  return load().site || {};
}

function population() {
  return load().population || {};
}

function settings() {
  const c = load();
  return {
    history: historyRange(),
    groups: c.groups || [],
    source: c.source || {},
    rootLabel: (c.source && c.source.label) || '中国人民银行 · 调查统计司',
    population: c.population || {},
  };
}

function reset() {
  cache = null;
}

module.exports = { load, list, byId, historyRange, site, population, settings, reset, ROOT, CONFIG_FILE };
