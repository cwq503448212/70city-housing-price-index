'use strict';

/**
 * JSON 文件缓存（居民存款：月度，按年分文件）
 *
 *   .cache/livelihood-deposit/years/<YYYY>.json   { year, months: { '01': {balance,demand,time} }, source }
 *   .cache/livelihood-deposit/population.json     { years: { '2024': 140828, ... }, fetchedAt, source }
 *   .cache/livelihood-deposit/_meta.json          { years: {...}, population: {...} } 回源时间与错误
 *
 * 只存上游原始值（亿元 / 万人），当月新增、累计新增、同比、人均都由服务层现算，
 * 换算逻辑不落盘，改公式不用清缓存。
 *
 * 目录可用环境变量 LIVELIHOOD_DEPOSIT_DATA_DIR 指向任意可写目录（打包分发时用）。
 * 独立于 .cache/livelihood：父模块的 stats() 会把子目录当成一个指标，混放会让健康检查失真。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

function dataDir() {
  return process.env.LIVELIHOOD_DEPOSIT_DATA_DIR || path.join(ROOT, '.cache', 'livelihood-deposit');
}

function yearsDir() {
  return path.join(dataDir(), 'years');
}

function yearFile(year) {
  return path.join(yearsDir(), year + '.json');
}

function populationFile() {
  return path.join(dataDir(), 'population.json');
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

function readYear(year) {
  const json = readJson(yearFile(year));
  if (!json || String(json.year) !== String(year)) return null;
  return json;
}

function writeYear(year, payload) {
  ensure(yearsDir());
  const body = {
    year: String(year),
    months: payload.months || {},
    source: payload.source || {},
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
  };
  fs.writeFileSync(yearFile(year), JSON.stringify(body), 'utf8');
}

function listYears() {
  let files = [];
  try {
    files = fs.readdirSync(yearsDir());
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => /^\d{4}\.json$/.test(f))
    .map((f) => f.slice(0, 4))
    .sort();
}

function readPopulation() {
  const json = readJson(populationFile());
  if (!json || !json.years) return null;
  return json;
}

function writePopulation(payload) {
  ensure(dataDir());
  fs.writeFileSync(
    populationFile(),
    JSON.stringify({
      years: payload.years || {},
      source: payload.source || 'nbs',
      fetchedAt: payload.fetchedAt || new Date().toISOString(),
    }),
    'utf8'
  );
}

function readMeta() {
  return readJson(metaFile()) || { years: {}, population: {} };
}

function writeMeta(meta) {
  ensure(dataDir());
  fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2), 'utf8');
}

/** 只读本地文件，不回源：供启动日志与健康检查用 */
function stats() {
  const dir = dataDir();
  const out = { dir: dir, years: 0, months: 0, populationYears: 0, latest: '' };
  const years = listYears();
  out.years = years.length;
  years.forEach((y) => {
    const one = readYear(y);
    const months = Object.keys((one && one.months) || {});
    out.months += months.length;
    if (months.length) {
      const last = y + '-' + months.sort()[months.length - 1];
      if (last > out.latest) out.latest = last;
    }
  });
  const pop = readPopulation();
  out.populationYears = pop ? Object.keys(pop.years || {}).length : 0;
  return out;
}

module.exports = {
  dataDir,
  yearsDir,
  yearFile,
  populationFile,
  readYear,
  writeYear,
  listYears,
  readPopulation,
  writePopulation,
  readMeta,
  writeMeta,
  stats,
};
