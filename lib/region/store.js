'use strict';

/**
 * JSON 文件缓存（区域经济：年度，按省份分文件）
 *
 *   .cache/region/<12 位省码>.json
 *     { code, name, series: { 指标id: { 年份: 值 } }, from, to, fetchedAt }
 *   .cache/region/_meta.json
 *     { provinces: { 省码: { 栏目: { lastAttempt, lastSuccess, lastError, latest } } } }
 *   冷却按「省 + 栏目」记录：首轮只拉 GDP 栏目，指数栏目随后补，
 *   若冷却按省记录，就把紧接着的指数回源也一起拦掉了。
 *
 * 为什么按省而不是按栏目分文件：前端通常只选几个省，按省读盘可以直接命中；
 * 单个省文件约 6 KB，31 个合计不到 200 KB，比按栏目分（每文件含 31 省）更小且更好增量。
 *
 * 只存上游原值（亿元 / 元 / 上年=100），占比与名义增速由服务层现算：
 * 公式改了不用清缓存，把计算值落盘反而会让口径改动后新旧数据混在一起。
 *
 * 目录可用环境变量 REGION_DATA_DIR 指向任意可写目录（打包分发时用）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function dataDir() {
  return process.env.REGION_DATA_DIR || path.join(ROOT, '.cache', 'region');
}

function provinceFile(code) {
  return path.join(dataDir(), String(code) + '.json');
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

function readProvince(code) {
  const json = readJson(provinceFile(code));
  if (!json || String(json.code) !== String(code) || !json.series) return null;
  return json;
}

function writeProvince(code, payload) {
  ensure(dataDir());
  const body = {
    code: String(code),
    name: payload.name || '',
    series: payload.series || {},
    from: payload.from || '',
    to: payload.to || '',
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
  };
  fs.writeFileSync(provinceFile(code), JSON.stringify(body), 'utf8');
}

function listProvinces() {
  let files = [];
  try {
    files = fs.readdirSync(dataDir());
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => /^\d{12}\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .sort();
}

function readMeta() {
  return readJson(metaFile()) || { provinces: {} };
}

function writeMeta(meta) {
  ensure(dataDir());
  fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2), 'utf8');
}

/** 只读本地文件，不回源：供启动日志与健康检查用 */
function stats() {
  const out = { dir: dataDir(), provinces: 0, series: 0, points: 0, years: 0, latestYear: '' };
  const yearSet = new Set();

  listProvinces().forEach((code) => {
    const one = readProvince(code);
    if (!one) return;
    out.provinces += 1;
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
  provinceFile,
  metaFile,
  readProvince,
  writeProvince,
  listProvinces,
  readMeta,
  writeMeta,
  stats,
};
