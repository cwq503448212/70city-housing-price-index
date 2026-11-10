'use strict';

/**
 * 指标配置装载与校验
 *
 * config/indicators.json 里有两类东西：
 *   catalogs   —— 国家数据（新版）站点上的「栏目」节点，栏目 id 由 probe.js 探测确认，禁止手填猜测值
 *   indicators —— 看板真正展示的指标；一个指标可以由多个「分期栏目」拼接（统计局会按年份拆栏目）
 *
 * 每条 indicator：
 *   id/label/unit/decimals/group
 *   kind:  index_yoy | index_mom | level_pmi | pct_yoy | amount_yoy ...
 *          （决定前端如何换算与配色，同比/环比/指数不得混画同一条线）
 *   release: { day } 发布日规则，用于 lib/macro/cache/policy.js 判断「该不该有数了」
 *   segments: [{ catalog, indicatorId, shown, from, to }]  按时间顺序拼接
 *   fallback: { dataset, series } DBnomics 兜底（仅在主源失效时使用，只提供近 13 期）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'indicators.json');

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/indicators.json 不是合法 JSON：' + e.message);
  }
  validate(json);
  cache = json;
  return cache;
}

function validate(json) {
  const problems = [];
  if (!json || typeof json !== 'object') problems.push('根节点不是对象');
  const catalogs = (json && json.catalogs) || {};
  const seen = new Set();

  ((json && json.indicators) || []).forEach((ind, i) => {
    const who = ind && ind.id ? ind.id : '#' + i;
    if (!ind || !ind.id) problems.push(who + ' 缺少 id');
    if (ind && seen.has(ind.id)) problems.push(who + ' id 重复');
    if (ind && ind.id) seen.add(ind.id);
    if (!ind || !ind.label) problems.push(who + ' 缺少 label');
    if (!ind || !ind.unit) problems.push(who + ' 缺少 unit');
    if (!ind || !ind.kind) problems.push(who + ' 缺少 kind');
    if (!ind || !Array.isArray(ind.segments) || !ind.segments.length) problems.push(who + ' 缺少 segments');
    ((ind && ind.segments) || []).forEach((seg) => {
      if (!seg || !seg.catalog) problems.push(who + ' segment 缺少 catalog');
      else if (!catalogs[seg.catalog]) problems.push(who + ' 引用了不存在的 catalog: ' + seg.catalog);
      if (!seg || !seg.indicatorId) problems.push(who + ' segment 缺少 indicatorId（必须由 probe.js 探测得出）');
    });
  });

  if (problems.length) throw new Error('指标配置有误：\n  - ' + problems.join('\n  - '));
}

function getCatalog(key) {
  const catalogs = load().catalogs || {};
  const c = catalogs[key];
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
  return { from: h.from || '2021-01', to: h.to || '' };
}

function settings() {
  const c = load();
  return {
    rootId: c.rootId,
    site: c.site || {},
    history: historyRange(),
    source: c.source || {},
    groups: c.groups || [],
  };
}

function reset() {
  cache = null;
}

module.exports = { load, list, byId, getCatalog, historyRange, settings, reset, ROOT, CONFIG_FILE };
