'use strict';

/**
 * JSON 文件缓存（年度）
 *
 * 键 = 指标 id + 年份，落盘为 .cache/livelihood/<id>/<YYYY>.json
 * 内容 = { id, year, raw, source, fetchedAt }
 *
 * raw 存上游原始值（万对 / 万人 / ‰），换算与格式化是接口层和前端的事。
 * 目录可用环境变量 LIVELIHOOD_DATA_DIR 指向任意可写目录（打包分发时用）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function dataDir() {
  return process.env.LIVELIHOOD_DATA_DIR || path.join(ROOT, '.cache', 'livelihood');
}

function indicatorDir(id) {
  return path.join(dataDir(), id);
}

function yearFile(id, year) {
  return path.join(indicatorDir(id), year + '.json');
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readYear(id, year) {
  try {
    const json = JSON.parse(fs.readFileSync(yearFile(id, year), 'utf8'));
    if (!json || json.year !== year) return null;
    return json;
  } catch (e) {
    return null;
  }
}

function writeYear(id, year, payload) {
  ensure(indicatorDir(id));
  const body = JSON.stringify(
    {
      id: id,
      year: year,
      raw: payload.raw,
      source: payload.source,
      fetchedAt: payload.fetchedAt || new Date().toISOString(),
    },
    null,
    0
  );
  fs.writeFileSync(yearFile(id, year), body, 'utf8');
}

function listYears(id) {
  let files = [];
  try {
    files = fs.readdirSync(indicatorDir(id));
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => /^\d{4}\.json$/.test(f))
    .map((f) => f.slice(0, 4))
    .sort();
}

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(indicatorDir(id), '_meta.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeMeta(id, meta) {
  ensure(indicatorDir(id));
  fs.writeFileSync(path.join(indicatorDir(id), '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function stats() {
  const dir = dataDir();
  const out = { dir: dir, indicators: 0, files: 0 };
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return out;
  }
  names.forEach((name) => {
    const full = path.join(dir, name);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch (e) {
      isDir = false;
    }
    if (!isDir) return;
    out.indicators += 1;
    try {
      out.files += fs.readdirSync(full).filter((f) => /^\d{4}\.json$/.test(f)).length;
    } catch (e) {
      /* ignore */
    }
  });
  return out;
}

module.exports = { dataDir, indicatorDir, yearFile, readYear, writeYear, listYears, readMeta, writeMeta, stats };
