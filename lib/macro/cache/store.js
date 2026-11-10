'use strict';

/**
 * JSON 文件缓存
 *
 * 键 = 指标 id + 统计月份，落盘为 .cache/macro/<id>/<YYYY-MM>.json
 * 内容 = { id, month, raw, source, fetchedAt }
 *
 * raw 存原始值（例如指数 101.3），换算成涨跌幅是前端/接口层的事，
 * 这样以后改口径不用重拉数据。
 *
 * 目录可用环境变量 MACRO_DATA_DIR 指向任意可写目录（打包成分发包时用）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

function dataDir() {
  return process.env.MACRO_DATA_DIR || path.join(ROOT, '.cache', 'macro');
}

function indicatorDir(id) {
  return path.join(dataDir(), id);
}

function monthFile(id, month) {
  return path.join(indicatorDir(id), month + '.json');
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readMonth(id, month) {
  try {
    const raw = fs.readFileSync(monthFile(id, month), 'utf8');
    const json = JSON.parse(raw);
    if (!json || json.month !== month) return null;
    return json;
  } catch (e) {
    return null;
  }
}

function writeMonth(id, month, payload) {
  ensure(indicatorDir(id));
  const body = JSON.stringify(
    {
      id: id,
      month: month,
      raw: payload.raw,
      source: payload.source,
      fetchedAt: payload.fetchedAt || new Date().toISOString(),
    },
    null,
    0
  );
  fs.writeFileSync(monthFile(id, month), body, 'utf8');
}

function listMonths(id) {
  let files = [];
  try {
    files = fs.readdirSync(indicatorDir(id));
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 7))
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
      out.files += fs.readdirSync(full).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).length;
    } catch (e) {
      /* ignore */
    }
  });
  return out;
}

module.exports = { dataDir, indicatorDir, monthFile, readMonth, writeMonth, listMonths, readMeta, writeMeta, stats };
