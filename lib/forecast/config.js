'use strict';

/**
 * 人口与住房推演 —— 配置装载与校验
 *
 * config/forecast.json 是唯一事实来源：
 *   site       —— 国家统计局「国家数据」年度库站点参数（rootId 必须是年度库）
 *   history    —— 历史起点（年度）
 *   catalogs   —— 年度库栏目 id（由 probe.js 实测确认，禁止手填猜测值）
 *   indicators —— 原值指标（catalog + indicatorId）与本页计算量（derive + inputs）
 *   model      —— 推演参数：学制、传导滞后、购房年龄段、情景假设、回测窗口
 *
 * 与民生模块同款取数模型，但这里多一层 model.js：
 * 官方原值只负责画历史，未来值全部由 model.js 现算，不落缓存、不回源。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'forecast.json');

/** 允许的计算口径（服务层按这些名字现算，不落盘、不回源） */
const DERIVES = ['rate_count'];

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
    throw new Error('config/forecast.json 不是合法 JSON：' + e.message);
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
  if (!YEAR.test(history.from || '')) problems.push('history.from 必须是年份（YYYY）');
  if (!json || !json.site || !HEX32.test((json.site && json.site.rootId) || '')) {
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
      return;
    }

    if (!ind || !ind.catalog) problems.push(who + ' 缺少 catalog');
    else if (!catalogs[ind.catalog]) problems.push(who + ' 引用了不存在的 catalog: ' + ind.catalog);
    if (!ind || !HEX32.test(ind.indicatorId || '')) {
      problems.push(who + ' indicatorId 必须是 32 位编码（必须由 probe.js 探测得出）');
    }
  });

  const list = (json && json.indicators) || [];
  const indMap = new Map(list.map((x) => [x && x.id, x]));
  list.forEach((ind) => {
    if (!ind || !ind.derive) return;
    ((ind.inputs) || []).forEach((dep) => {
      if (!indMap.has(dep)) problems.push(ind.id + ' 的 inputs 引用了不存在的指标: ' + dep);
      if (dep === ind.id) problems.push(ind.id + ' 的 inputs 不能引用自己');
    });
  });

  const model = (json && json.model) || {};
  if (!YEAR.test(model.horizon || '')) problems.push('model.horizon 必须是年份（YYYY）');
  if (!(Number(model.calibrationYears) > 0)) problems.push('model.calibrationYears 必须是正整数');

  const stages = model.stages || {};
  const stageKeys = Object.keys(stages);
  if (!stageKeys.length) problems.push('model.stages 不能为空');
  stageKeys.forEach((key) => {
    const s = stages[key] || {};
    if (!s.label) problems.push('stages.' + key + ' 缺少 label');
    if (!(Number(s.years) > 0)) problems.push('stages.' + key + ' 的 years 必须是正整数');
    ['admit', 'enroll', 'graduate'].forEach((f) => {
      if (!indMap.has(s[f])) problems.push('stages.' + key + '.' + f + ' 引用了不存在的指标: ' + s[f]);
    });
    if (s.upstream !== 'birth' && !stages[s.upstream]) {
      problems.push('stages.' + key + '.upstream 必须是 birth 或已声明的学段');
    }
    if (!(Number(s.lag) > 0)) problems.push('stages.' + key + '.lag 必须是正整数');
    if (!Array.isArray(s.weights) || s.weights.length !== Number(s.years)) {
      problems.push('stages.' + key + '.weights 长度必须等于 years');
    }
  });
  // 上游不能成环
  stageKeys.forEach((key) => {
    const chain = new Set();
    let cur = key;
    while (cur && cur !== 'birth') {
      if (chain.has(cur)) {
        problems.push('stages 的上游成环：' + Array.from(chain).join(' → ') + ' → ' + cur);
        break;
      }
      chain.add(cur);
      cur = (stages[cur] || {}).upstream;
      if (!cur) break;
    }
  });

  const housing = model.housing || {};
  if (!(housing.buyerAgeFrom >= 0) || !(housing.buyerAgeTo > housing.buyerAgeFrom)) {
    problems.push('model.housing 的购房年龄段不合法');
  }

  const scenarios = model.scenarios || {};
  ['low', 'base', 'high'].forEach((key) => {
    const s = scenarios[key];
    if (!s) {
      problems.push('model.scenarios 缺少 ' + key + ' 情景');
      return;
    }
    if (!s.label) problems.push('scenarios.' + key + ' 缺少 label');
    ['birthGrowth', 'houseIntensity', 'priceGrowth'].forEach((f) => {
      if (!isFinite(Number(s[f]))) problems.push('scenarios.' + key + '.' + f + ' 必须是数字');
    });
  });

  if (problems.length) throw new Error('推演模块配置有误：\n  - ' + problems.join('\n  - '));
}

function getCatalog(key) {
  const c = (load().catalogs || {})[key];
  if (!c) throw new Error('未知栏目: ' + key);
  return c;
}

function list() {
  return load().indicators;
}

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

function model() {
  return load().model || {};
}

function settings() {
  const c = load();
  return {
    site: c.site || {},
    history: historyRange(),
    groups: c.groups || [],
    model: model(),
    source: c.source || {},
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
  model,
  settings,
  reset,
  DERIVES,
  ROOT,
  CONFIG_FILE,
};
