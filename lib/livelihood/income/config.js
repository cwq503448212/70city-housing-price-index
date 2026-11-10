'use strict';

/**
 * 人均收入与支出（民生子模块）配置装载与校验
 *
 * config/income.json 是唯一事实来源：
 *   source     —— 前端展示的数据来源与口径说明（年度库只有名义增速）
 *   history    —— 历史起点（2013：城乡一体化住户调查新口径）
 *   catalogs   —— 年度库栏目 id（由 probe.js 探测确认，禁止手填猜测值）
 *   indicators —— 看板展示的指标：group 决定分组，catalog + indicatorId 决定取数位置
 *
 * 取数通道与 lib/livelihood 完全一致（年度库 + 1.2 秒间隔串行），
 * 因此这里只放「配置」，网络与限流复用父目录的 source / queue。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'income.json');

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/income.json 不是合法 JSON：' + e.message);
  }
  validate(json);
  cache = json;
  return cache;
}

function validate(json) {
  const problems = [];
  if (!json || typeof json !== 'object') problems.push('根节点不是对象');
  const catalogs = (json && json.catalogs) || {};
  const history = (json && json.history) || {};
  if (!/^\d{4}$/.test(history.from || '')) problems.push('history.from 必须是年份（YYYY）');

  const groups = new Set(((json && json.groups) || []).map((g) => g && g.key));
  Object.keys(catalogs).forEach((k) => {
    const c = catalogs[k] || {};
    if (!/^[0-9a-f]{32}$/.test(c.id || '')) {
      problems.push('catalogs.' + k + '.id 必须是 32 位编码（必须由 probe.js 探测得出）');
    }
  });

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
    if (!ind || !ind.catalog) problems.push(who + ' 缺少 catalog');
    else if (!catalogs[ind.catalog]) problems.push(who + ' 引用了不存在的 catalog: ' + ind.catalog);
    if (!ind || !/^[0-9a-f]{32}$/.test(ind.indicatorId || '')) {
      problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe.js 探测得出）');
    }
  });

  if (problems.length) throw new Error('人均收支指标配置有误：\n  - ' + problems.join('\n  - '));
}

function getCatalog(key) {
  const c = (load().catalogs || {})[key];
  if (!c) throw new Error('未知栏目: ' + key);
  return c;
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
  return { from: h.from || '2013', to: '' };
}

function settings() {
  const c = load();
  return {
    history: historyRange(),
    groups: c.groups || [],
    source: c.source || {},
    rootLabel: (c.source && c.source.label) || '国家统计局 · 国家数据（年度）',
  };
}

function reset() {
  cache = null;
}

module.exports = { load, list, byId, getCatalog, historyRange, settings, reset, ROOT, CONFIG_FILE };
