'use strict';

/**
 * JSON 文件缓存（房地产：月度 + 年度，按栏目分文件）
 *
 *   .cache/realestate/catalogs/<栏目>.json
 *     { catalog, freq, catalogId, series: { 指标id: { 期别: 值 } }, from, to, fetchedAt }
 *   .cache/realestate/_meta.json
 *     { catalogs: { 栏目: { lastAttempt, lastSuccess, lastError, latest } } }
 *
 * 只存上游原值（万平方米 / 亿元 / % / 元每平方米 / 套），均价、单月值、利润率等
 * 计算量都由服务层现算，换算逻辑不落盘，改公式不用清缓存。
 *
 * 目录可用环境变量 REALESTATE_DATA_DIR 指向任意可写目录（打包分发时用）。
 * 独立于 .cache/livelihood：那是民生模块的缓存根，混放会让它的健康检查失真。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function dataDir() {
  return process.env.REALESTATE_DATA_DIR || path.join(ROOT, '.cache', 'realestate');
}

function catalogsDir() {
  return path.join(dataDir(), 'catalogs');
}

function catalogFile(key) {
  return path.join(catalogsDir(), key + '.json');
}

function metaFile() {
  return path.join(dataDir(), '_meta.json');
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readCatalog(key) {
  const json = readJson(catalogFile(key));
  if (!json || String(json.catalog) !== String(key) || !json.series) return null;
  return json;
}

function writeCatalog(key, payload) {
  ensure(catalogsDir());
  const body = {
    catalog: String(key),
    freq: payload.freq || 'month',
    catalogId: payload.catalogId || '',
    series: payload.series || {},
    from: payload.from || '',
    to: payload.to || '',
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
  };
  fs.writeFileSync(catalogFile(key), JSON.stringify(body), 'utf8');
}

function listCatalogs() {
  let files = [];
  try {
    files = fs.readdirSync(catalogsDir());
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => /^[\w-]+\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .sort();
}

function readMeta() {
  return readJson(metaFile()) || { catalogs: {} };
}

function writeMeta(meta) {
  ensure(dataDir());
  fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2), 'utf8');
}

/** 只读本地文件，不回源：供启动日志与健康检查用 */
function stats() {
  const out = {
    dir: dataDir(),
    catalogs: 0,
    series: 0,
    points: 0,
    months: 0,
    years: 0,
    latestMonth: '',
    latestYear: '',
  };
  const monthSet = new Set();
  const yearSet = new Set();

  listCatalogs().forEach((key) => {
    const one = readCatalog(key);
    if (!one) return;
    out.catalogs += 1;
    const isYear = one.freq === 'year';
    Object.keys(one.series || {}).forEach((iid) => {
      const map = one.series[iid] || {};
      const periods = Object.keys(map);
      if (!periods.length) return;
      out.series += 1;
      out.points += periods.length;
      periods.forEach((p) => (isYear ? yearSet : monthSet).add(p));
    });
  });

  out.months = monthSet.size;
  out.years = yearSet.size;
  out.latestMonth = monthSet.size ? Array.from(monthSet).sort().pop() : '';
  out.latestYear = yearSet.size ? Array.from(yearSet).sort().pop() : '';
  return out;
}

module.exports = {
  dataDir,
  catalogsDir,
  catalogFile,
  readCatalog,
  writeCatalog,
  listCatalogs,
  readMeta,
  writeMeta,
  stats,
};
