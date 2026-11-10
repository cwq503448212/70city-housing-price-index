'use strict';

/**
 * LPR 缓存：一条序列全量存一个文件（数据量小，约 90 期 / 几 KB，不做按期分文件）
 *
 * .cache/lpr/lpr.json   = { updatedAt, source, records: [{ date, y1, y5 }] }
 * .cache/lpr/_meta.json = { lastAttempt, lastSuccess, lastError, lastCount }
 *
 * records 升序；y1/y5 存原始值（3.5 表示 3.50%），换算成 bp / 百分点是接口与前端的事。
 * 目录可用环境变量 LPR_DATA_DIR 指向任意可写目录（打包分发时用）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function dataDir() {
  return process.env.LPR_DATA_DIR || path.join(ROOT, '.cache', 'lpr');
}

function dataFile() {
  return path.join(dataDir(), 'lpr.json');
}

function metaFile() {
  return path.join(dataDir(), '_meta.json');
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读全量缓存；损坏 / 不存在返回 null */
function read() {
  try {
    const json = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    if (!json || !Array.isArray(json.records)) return null;
    return json;
  } catch (e) {
    return null;
  }
}

function write(records, source) {
  ensure(dataDir());
  const body = { updatedAt: new Date().toISOString(), source: source, records: records };
  fs.writeFileSync(dataFile(), JSON.stringify(body), 'utf8');
  return body;
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 合并写 meta；每次调用都刷新 lastAttempt（回源冷却的起点） */
function writeMeta(patch) {
  ensure(dataDir());
  const meta = Object.assign(readMeta() || {}, patch || {}, { lastAttempt: new Date().toISOString() });
  fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/** 健康检查 / 启动日志用 */
function stats() {
  const data = read();
  return {
    dir: dataDir(),
    exists: !!data,
    count: data ? data.records.length : 0,
    firstDate: data && data.records.length ? data.records[0].date : null,
    lastDate: data && data.records.length ? data.records[data.records.length - 1].date : null,
    updatedAt: data ? data.updatedAt : null,
  };
}

module.exports = { dataDir, read, write, readMeta, writeMeta, stats };
