'use strict';

/**
 * HTTP 接口层（人均收入与支出）
 *
 *   GET /api/livelihood/income-expenditure              看板一次性取全量数据
 *   GET /api/livelihood/income-expenditure/indicators   指标清单（不含数据）
 *   GET /api/livelihood/income-expenditure/series/:id   单指标序列
 *   GET /api/livelihood/income-expenditure/refresh/:id  手动刷新单指标（等价于 series?id&force=1）
 *   GET /api/livelihood/income-expenditure/health       健康检查
 *
 * 查询参数（年度口径）：
 *   range=5|10|all          近 N 年 / 全部（2013 起）
 *   from=YYYY & to=YYYY     自定义区间（优先于 range）
 *   force=1                 跳过缓存，强制回源
 */

const config = require('./config');
const policy = require('../policy');
const store = require('./store');
const service = require('./service');

const RANGE_PRESET = {
  '5': { years: 5, label: '近 5 年' },
  '10': { years: 10, label: '近 10 年' },
  all: { years: 0, label: '全部（2013 起）' },
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
  const key = String(query.range || 'all');
  const preset = RANGE_PRESET[key] || RANGE_PRESET.all;
  if (!preset.years) return { from: history.from, to: to, label: preset.label };
  const from = String(Number(to) - preset.years + 1);
  return { from: from > history.from ? from : history.from, to: to, label: preset.label };
}

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

function presets() {
  return Object.keys(RANGE_PRESET).map((k) => ({ key: k, label: RANGE_PRESET[k].label }));
}

async function overview(query) {
  const r = resolveRange(query);
  const data = await service.overview({ from: r.from, to: r.to, force: truthy(query.force) });
  const settings = config.settings();
  data.range.label = r.label;
  data.presets = presets();
  data.history = config.historyRange();
  data.source = {
    label: settings.rootLabel,
    url: (settings.source && settings.source.url) || 'https://data.stats.gov.cn',
    chapter: (settings.source && settings.source.chapter) || '',
    note: (settings.source && settings.source.note) || '',
  };
  return data;
}

async function indicators() {
  return {
    history: config.historyRange(),
    groups: config.settings().groups,
    presets: presets(),
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
