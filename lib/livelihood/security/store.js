'use strict';

/**
 * JSON 文件缓存（养老医保：年度，按栏目分文件）
 *
 *   .cache/livelihood-security/catalogs/<栏目>.json
 *     { catalog, catalogId, series: { 指标id: { 年份: 值 } }, from, to, fetchedAt }
 *   .cache/livelihood-security/_meta.json
 *     { catalogs: { 栏目: { lastAttempt, lastSuccess, lastError, latest } } }
 *
 * 只存上游原值（亿元 / 万人），当期结余、人均养老金、可支付月数、参保率全部由
 * 服务层现算：公式改了不用清缓存，把计算值落盘反而会让口径改动后新旧数据混在一起。
 *
 * 目录可用环境变量 LIVELIHOOD_SECURITY_DATA_DIR 指向任意可写目录（打包分发时用）。
 * 独立于 .cache/livelihood：父模块的 stats() 会把子目录当成一个指标，混放会让健康检查失真。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

function dataDir() {
  return process.env.LIVELIHOOD_SECURITY_DATA_DIR || path.join(ROOT, '.cache', 'livelihood-security');
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
  const out = { dir: dataDir(), catalogs: 0, series: 0, points: 0, years: 0, latestYear: '' };
  const yearSet = new Set();

  listCatalogs().forEach((key) => {
    const one = readCatalog(key);
    if (!one) return;
    out.catalogs += 1;
    Object.keys(one.series || {}).forEach((iid) => {
      const periods = Object.keys(one.series[iid] || {});
      if (!periods.length) return;
      out.series += 1;
      out.points += periods.length;
      periods.forEach((p) => yearSet.add(p));
    });
  });

  out.years = yearSet.size;
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
