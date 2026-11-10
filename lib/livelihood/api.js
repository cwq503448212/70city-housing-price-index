'use strict';

/**
 * HTTP 接口层
 *
 *   GET /api/livelihood/health          健康检查
 *   GET /api/livelihood/indicators      指标清单（不含数据）
 *   GET /api/livelihood/overview        看板一次性取全量数据（顶部时间选择 -> 全图联动）
 *   GET /api/livelihood/series/:id      单指标序列
 *   GET /api/livelihood/refresh/:id     手动刷新单指标（等价于 series?id&force=1）
 *
 * 查询参数（年度口径）：
 *   range=10|20|30|all      近 N 年 / 全部（1978 起）
 *   from=YYYY & to=YYYY     自定义区间（优先于 range）
 *   force=1                 跳过缓存，强制回源
 */

const config = require('./config');
const policy = require('./policy');
const store = require('./store');
const service = require('./service');

const RANGE_PRESET = {
  '10': { years: 10, label: '近 10 年' },
  '20': { years: 20, label: '近 20 年' },
  '30': { years: 30, label: '近 30 年' },
  all: { years: 0, label: '全部（1978 起）' },
};

function isYear(v) {
  return /^\d{4}$/.test(v || '');
}

function resolveRange(query) {
  const history = config.historyRange();
  const expectedLatest = policy.expectedLatestYear(new Date());
  const to = isYear(query.to) && query.to < expectedLatest ? query.to : expectedLatest;

  if (isYear(query.from)) {
    return { from: query.from > history.from ? query.from : history.from, to: to, label: '自定义' };
  }
  const key = String(query.range || '20');
  const preset = RANGE_PRESET[key] || RANGE_PRESET['20'];
  if (!preset.years) return { from: history.from, to: to, label: preset.label };
  const from = String(Number(to) - preset.years + 1);
  return { from: from > history.from ? from : history.from, to: to, label: preset.label };
}

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

async function overview(query) {
  const r = resolveRange(query);
  const data = await service.overview({ from: r.from, to: r.to, force: truthy(query.force) });
  data.range.label = r.label;
  data.presets = Object.keys(RANGE_PRESET).map((k) => ({ key: k, label: RANGE_PRESET[k].label }));
  data.history = config.historyRange();
  data.source = { label: config.settings().rootLabel, url: 'https://data.stats.gov.cn' };
  return data;
}

async function indicators() {
  return {
    history: config.historyRange(),
    groups: config.settings().groups,
    presets: Object.keys(RANGE_PRESET).map((k) => ({ key: k, label: RANGE_PRESET[k].label })),
    indicators: config.list().map((ind) => service.descriptor(ind)),
    cache: store.stats(),
  };
}

async function one(id, query) {
  const r = resolveRange(query);
  const data = await service.getSeries(id, { from: r.from, to: r.to, force: truthy(query.force) });
  data.range = { from: r.from, to: r.to, label: r.label };
  return data;
}

function health() {
  const set = service.datasetStatus();
  return { cache: store.stats(), dataset: set, stale: set.behind > 0 || !set.files };
}

module.exports = { overview, indicators, one, health, resolveRange, RANGE_PRESET };
