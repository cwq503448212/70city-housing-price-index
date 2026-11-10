'use strict';

/**
 * HTTP 接口层（居民存款与人均存款）
 *
 *   GET /api/livelihood/reserve-deposit              看板一次性取全量数据
 *   GET /api/livelihood/reserve-deposit/indicators   指标清单（不含数据）
 *   GET /api/livelihood/reserve-deposit/series/:id   单指标序列
 *   GET /api/livelihood/reserve-deposit/refresh/:id  手动刷新单指标（等价于 series?id&force=1）
 *   GET /api/livelihood/reserve-deposit/health       健康检查
 *
 * 查询参数（月度口径）：
 *   range=2|5|all           近 N 年 / 全部（2015 起），默认 5
 *   from=YYYY-MM & to=YYYY-MM  自定义区间（优先于 range）
 *   force=1                 跳过缓存，强制回源
 */

const config = require('./config');
const policy = require('./policy');
const store = require('./store');
const service = require('./service');

const RANGE_PRESET = {
  '2': { months: 24, label: '近 2 年' },
  '5': { months: 60, label: '近 5 年' },
  all: { months: 0, label: '全部（2015 起）' },
};

function isMonth(v) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v || '');
}

function resolveRange(query) {
  const history = config.historyRange();
  const from0 = history.from + '-01';
  const expected = policy.expectedLatestMonth(new Date());
  const to = isMonth(query.to) && query.to < expected ? query.to : expected;

  if (isMonth(query.from)) {
    return { from: query.from > from0 ? query.from : from0, to: to, label: '自定义' };
  }
  const key = String(query.range || '5');
  const preset = RANGE_PRESET[key] || RANGE_PRESET['5'];
  if (!preset.months) return { from: from0, to: to, label: preset.label };
  const from = policy.addMonths(to, -(preset.months - 1));
  return { from: from > from0 ? from : from0, to: to, label: preset.label };
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
  data.range.label = r.label;
  data.presets = presets();
  data.source = {
    label: (data.source && data.source.label) || '中国人民银行 · 调查统计司',
    url: (data.source && data.source.url) || 'https://www.pbc.gov.cn',
    chapter: (data.source && data.source.chapter) || '',
    note: (data.source && data.source.note) || '',
  };
  return data;
}

async function indicators() {
  return {
    history: { from: config.historyRange().from + '-01', to: '' },
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
