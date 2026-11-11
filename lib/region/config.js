'use strict';

/**
 * 区域经济（分省 GDP）配置装载与校验
 *
 * config/region.json 是唯一事实来源：
 *   site       —— 国家数据「分省年度数据」的站点参数（rootId 必须是分省年度库，不是全国年度库）
 *   history    —— 历史起点（年度，'YYYY'）
 *   provinces  —— 31 个省级行政区与 12 位行政区划代码（das 参数用）
 *   catalogs   —— 分省年度库栏目 id（用本目录 source.js 的 tree / indicatorsOf 探测确认，
 *                  code=6 分省库不在 probe.js 的命令里；禁止手填猜测值）
 *   indicators —— 看板展示的指标：原值写 catalog + indicatorId；
 *                 本页计算量写 derive + inputs（不落盘、不回源）
 *
 * 与民生年度模块同款模型，区别只在「地区」维度：一条序列 = 一个省 × 一个指标。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'region.json');

/**
 * 允许的计算口径（服务层按这些名字现算，不落盘、不回源）
 *   share_pct     a ÷ b × 100            （两个 inputs）
 *   yoy_nominal   (当年 a − 上年 a) ÷ 上年 a × 100（一个 input，服务层自动取上一年）
 */
const DERIVES = {
  share_pct: 2,
  yoy_nominal: 1,
};

const KINDS = ['level', 'percent', 'index_yoy'];

const CODE12 = /^\d{12}$/;
const HEX32 = /^[0-9a-f]{32}$/i;

let cache = null;

function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('config/region.json 不是合法 JSON：' + e.message);
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
  if (!HEX32.test(site.rootId || '')) problems.push('site.rootId 必须是 32 位编码（分省年度库根节点）');
  if (Number(site.code) !== 6) problems.push('site.code 必须是 6（分省年度数据），全国年度库是 3');

  const catalogs = (json && json.catalogs) || {};
  Object.keys(catalogs).forEach((key) => {
    const one = catalogs[key] || {};
    if (!HEX32.test(one.catalogId || '')) problems.push('catalogs.' + key + '.catalogId 必须是 32 位编码');
    if (one.from && !/^\d{4}$/.test(one.from)) problems.push('catalogs.' + key + '.from 必须是年份');
  });

  const provinces = (json && json.provinces) || [];
  if (!Array.isArray(provinces) || provinces.length !== 31) {
    problems.push('provinces 必须是 31 个省级行政区（不含港澳台）');
  }
  const codes = new Set();
  provinces.forEach((p, i) => {
    const who = 'provinces[' + i + ']';
    if (!p || !CODE12.test(p.code || '')) problems.push(who + ' 的 code 必须是 12 位行政区划代码');
    if (p && codes.has(p.code)) problems.push(who + ' 的 code 重复：' + p.code);
    if (p && p.code) codes.add(p.code);
    if (!p || !p.name) problems.push(who + ' 缺少 name');
    if (!p || !p.short) problems.push(who + ' 缺少 short');
  });

  const groups = new Set(((json && json.groups) || []).map((g) => g && g.key));
  const seen = new Set();
  const list = (json && json.indicators) || [];
  list.forEach((ind, i) => {
    const who = ind && ind.id ? ind.id : '#' + i;
    if (!ind || !ind.id) problems.push(who + ' 缺少 id');
    if (ind && seen.has(ind.id)) problems.push(who + ' id 重复');
    if (ind && ind.id) seen.add(ind.id);
    if (!ind || !ind.label) problems.push(who + ' 缺少 label');
    if (!ind || !ind.unit) problems.push(who + ' 缺少 unit');
    if (!ind || !ind.kind) problems.push(who + ' 缺少 kind');
    if (ind && KINDS.indexOf(ind.kind) === -1) problems.push(who + ' 未知 kind：' + ind.kind);
    if (ind && ind.group && !groups.has(ind.group)) problems.push(who + ' 引用了不存在的 group：' + ind.group);
    // lagYears：随年鉴入库、比 GDP 晚一年发布的指标（行业增加值、分产业指数）
    if (ind && ind.lagYears !== undefined) {
      const n = Number(ind.lagYears);
      if (!isFinite(n) || n < 0 || n > 2 || Math.round(n) !== n) {
        problems.push(who + ' 的 lagYears 必须是 0—2 的整数');
      }
    }

    if (ind && ind.derive) {
      const need = DERIVES[ind.derive];
      if (need === undefined) {
        problems.push(who + ' 未知计算口径：' + ind.derive);
        return;
      }
      if (!Array.isArray(ind.inputs) || ind.inputs.length !== need) {
        problems.push(who + ' 的计算口径 ' + ind.derive + ' 需要正好 ' + need + ' 个 inputs');
      }
      if (ind.catalog || ind.indicatorId) problems.push(who + ' 是计算量，不应再写 catalog / indicatorId');
      return;
    }

    if (!ind || !ind.catalog) problems.push(who + ' 缺少 catalog');
    else if (!catalogs[ind.catalog]) problems.push(who + ' 引用了不存在的 catalog：' + ind.catalog);
    if (!ind || !HEX32.test(ind.indicatorId || '')) {
      problems.push(who + ' 的 indicatorId 必须是 32 位编码（必须由 probe.js 探测得出）');
    }
  });

  // 计算量的 inputs 必须指向已声明的指标，且不能自引用 / 互相成环
  const indMap = new Map(list.map((x) => [x && x.id, x]));
  list.forEach((ind) => {
    if (!ind || !ind.derive) return;
    (ind.inputs || []).forEach((dep) => {
      if (!indMap.has(dep)) problems.push(ind.id + ' 的 inputs 引用了不存在的指标：' + dep);
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

  if (problems.length) throw new Error('区域经济指标配置有误：\n  - ' + problems.join('\n  - '));
}

function getCatalog(key) {
  const c = (load().catalogs || {})[key];
  if (!c) throw new Error('未知栏目：' + key);
  return Object.assign({ key: key }, c);
}

function catalogs() {
  return Object.keys(load().catalogs || {}).map((key) => getCatalog(key));
}

function list() {
  return load().indicators;
}

// 客户端传了不存在的 id 属于「请求错误」，不是服务端故障 → 带 status=404
function byId(id) {
  const found = list().filter((x) => x.id === id)[0];
  if (!found) {
    const e = new Error('未知指标：' + id);
    e.status = 404;
    throw e;
  }
  return found;
}

function provinces() {
  return load().provinces;
}

function provinceByCode(code) {
  return provinces().filter((p) => p.code === String(code || ''))[0] || null;
}

/** '11,44' 或 ['110000000000'] → 省份对象数组；未知代码抛 404 */
function resolveProvinces(input) {
  const all = provinces();
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  const tokens = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!tokens.length) return all;
  const out = tokens.map((t) => {
    const hit =
      provinceByCode(t) ||
      all.filter((p) => p.short === t || p.name === t || p.code.slice(0, 2) === t)[0];
    if (!hit) {
      const e = new Error('未知省份：' + t);
      e.status = 404;
      throw e;
    }
    return hit;
  });
  return out;
}

function historyRange() {
  const h = load().history || {};
  return { from: h.from || '1992', to: '' };
}

function releaseMonth() {
  return Number(load().releaseMonth || 2);
}

function settings() {
  const c = load();
  return {
    site: c.site || {},
    history: historyRange(),
    groups: c.groups || [],
    releaseMonth: releaseMonth(),
    rootLabel: (c.source && c.source.label) || '国家数据 · 分省年度数据',
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
  getCatalog,
  provinces,
  provinceByCode,
  resolveProvinces,
  historyRange,
  releaseMonth,
  settings,
  reset,
  DERIVES,
  KINDS,
  ROOT,
  CONFIG_FILE,
};
