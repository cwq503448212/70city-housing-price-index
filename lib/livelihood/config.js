'use strict';

/**
 * 民生模块（婚育）配置装载与校验
 *
 * config/livelihood.json 是唯一事实来源：
 *   site       —— 国家统计局「国家数据」年度库的站点参数（rootId 必须是年度库，不是月度库）
 *   history    —— 历史起点（年度，'YYYY'）
 *   catalogs   —— 年度库栏目 id（由 probe.js 探测确认，禁止手填猜测值）
 *   indicators —— 看板展示的指标：kind 决定前端换算与配色，catalog+indicatorId 决定取数位置
 *
 * 与宏观模块同款模型，但期别是「年度」：
 *   - 一条序列只来自单一栏目（同一年度库内的多指标可一次请求批量取回）
 *   - 不配兜底镜像：年度婚姻 / 人口数据没有稳定的镜像源，上游失败就回退缓存并标 stale
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'livelihood.json');

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/livelihood.json 不是合法 JSON：' + e.message);
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
  if (!json || !json.site || !/^[0-9a-f]{32}$/.test((json.site && json.site.rootId) || '')) {
    problems.push('site.rootId 必须是 32 位编码（年度库根节点）');
  }

  const seen = new Set();
  ((json && json.indicators) || []).forEach((ind, i) => {
    const who = ind && ind.id ? ind.id : '#' + i;
    if (!ind || !ind.id) problems.push(who + ' 缺少 id');
    if (ind && seen.has(ind.id)) problems.push(who + ' id 重复');
    if (ind && ind.id) seen.add(ind.id);
    if (!ind || !ind.label) problems.push(who + ' 缺少 label');
    if (!ind || !ind.unit) problems.push(who + ' 缺少 unit');
    if (!ind || !ind.kind) problems.push(who + ' 缺少 kind');
    if (!ind || !ind.catalog) problems.push(who + ' 缺少 catalog');
    else if (!catalogs[ind.catalog]) problems.push(who + ' 引用了不存在的 catalog: ' + ind.catalog);
    if (!ind || !/^[0-9a-f]{32}$/.test(ind.indicatorId || '')) {
      problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe.js 探测得出）');
    }
  });

  if (problems.length) throw new Error('民生指标配置有误：\n  - ' + problems.join('\n  - '));
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
  return { from: h.from || '1978', to: '' };
}

function settings() {
  const c = load();
  return {
    site: c.site || {},
    history: historyRange(),
    groups: c.groups || [],
    rootLabel: (c.site && c.site.rootLabel) || '国家数据 · 年度数据',
  };
}

function reset() {
  cache = null;
}

module.exports = { load, list, byId, getCatalog, historyRange, settings, reset, ROOT, CONFIG_FILE };
