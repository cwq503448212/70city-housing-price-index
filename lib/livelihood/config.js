'use strict';

/**
 * 民生模块（人口与婚育）配置装载与校验
 *
 * config/livelihood.json 是唯一事实来源：
 *   site       —— 国家统计局「国家数据」年度库的站点参数（rootId 必须是年度库，不是月度库）
 *   history    —— 历史起点（年度，'YYYY'）
 *   catalogs   —— 年度库栏目 id（由 probe.js 探测确认，禁止手填猜测值）
 *   indicators —— 看板展示的指标：kind 决定前端换算与配色；
 *                 原值写 catalog + indicatorId（由 probe.js 探测确认，禁止手填猜测值）；
 *                 本页计算量写 derive + inputs（不落盘、不回源）
 *
 * 与宏观模块同款模型，但期别是「年度」：
 *   - 一条序列只来自单一栏目（同一年度库内的多指标可一次请求批量取回）
 *   - 不配兜底镜像：年度婚姻 / 人口数据没有稳定的镜像源，上游失败就回退缓存并标 stale
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'livelihood.json');

/**
 * 允许的计算口径（服务层按这些名字现算，不落盘、不回源）
 *   rate_count  千分率 × 年平均人口 ÷ 1000 → 万人（出生 / 死亡人口）
 *   diff        a − b
 *   ratio       a ÷ b（倍）
 */
const DERIVES = ['rate_count', 'diff', 'ratio'];

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

    if (ind && ind.derive) {
      if (DERIVES.indexOf(ind.derive) === -1) problems.push(who + ' 未知计算口径: ' + ind.derive);
      if (!Array.isArray(ind.inputs) || ind.inputs.length !== 2) {
        problems.push(who + ' 计算量必须正好两个 inputs（a op b）');
      }
      if (ind.catalog || ind.indicatorId) problems.push(who + ' 计算量不应再写 catalog / indicatorId');
      if (ind.until) problems.push(who + ' 计算量不应写 until（有效期跟着输入指标走）');
      return;
    }

    if (!ind || !ind.catalog) problems.push(who + ' 缺少 catalog');
    else if (!catalogs[ind.catalog]) problems.push(who + ' 引用了不存在的 catalog: ' + ind.catalog);
    if (!ind || !/^[0-9a-f]{32}$/.test(ind.indicatorId || '')) {
      problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe.js 探测得出）');
    }
  });

  // 计算量的 inputs 必须指向已声明的指标，且不能自引用 / 互相成环
  const list = (json && json.indicators) || [];
  const indMap = new Map(list.map((x) => [x && x.id, x]));
  list.forEach((ind) => {
    if (!ind || !ind.derive) return;
    ((ind.inputs) || []).forEach((dep) => {
      if (!indMap.has(dep)) problems.push(ind.id + ' 的 inputs 引用了不存在的指标: ' + dep);
      if (dep === ind.id) problems.push(ind.id + ' 的 inputs 不能引用自己');
    });
  });
  list.forEach((ind) => {
    if (!ind || !ind.derive) return;
    const chain = new Set();
    (function walk(id) {
      if (chain.has(id)) {
        problems.push(ind.id + ' 的计算链成环：' + Array.from(chain).join(' → ') + ' → ' + id);
        return;
      }
      const one = indMap.get(id);
      if (!one || !one.derive) return;
      chain.add(id);
      (one.inputs || []).forEach(walk);
      chain.delete(id);
    })(ind.id);
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

module.exports = {
  load,
  list,
  byId,
  getCatalog,
  historyRange,
  settings,
  reset,
  DERIVES,
  ROOT,
  CONFIG_FILE,
};
