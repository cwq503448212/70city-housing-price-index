'use strict';

/**
 * JSON 文件缓存（行业运行：月度，按栏目分文件）
 *
 *   .cache/industry/catalogs/<栏目>.json   { catalog, series: { 指标id: { 'YYYY-MM': 值 } }, fetchedAt }
 *   .cache/industry/_meta.json             { catalogs: { 栏目: { lastAttempt, lastSuccess, lastError, latest } } }
 *
 * 只存上游原值（%），任何换算都在服务层 / 前端做，不落盘：
 * 改排名口径、改热力图取值都不用清缓存。
 *
 * 目录可用环境变量 INDUSTRY_DATA_DIR 指向任意可写目录（打包分发时用）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function dataDir() {
  return process.env.INDUSTRY_DATA_DIR || path.join(ROOT, '.cache', 'industry');
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
  const out = { dir: dataDir(), catalogs: 0, series: 0, points: 0, months: 0, latest: '' };
  const keys = listCatalogs();
  const monthSet = new Set();
  keys.forEach((key) => {
    const one = readCatalog(key);
    if (!one) return;
    out.catalogs += 1;
    Object.keys(one.series || {}).forEach((iid) => {
      const map = one.series[iid] || {};
      const months = Object.keys(map);
      if (!months.length) return;
      out.series += 1;
      out.points += months.length;
      months.forEach((m) => monthSet.add(m));
    });
  });
  out.months = monthSet.size;
  out.latest = monthSet.size ? Array.from(monthSet).sort().pop() : '';
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
