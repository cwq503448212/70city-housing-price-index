'use strict';

/**
 * HTTP 接口层（就业）
 *
 *   GET /api/livelihood/employment              看板一次性取全量数据
 *   GET /api/livelihood/employment/indicators   指标清单（不含数据）
 *   GET /api/livelihood/employment/series/:id   单指标序列
 *   GET /api/livelihood/employment/refresh/:id  手动刷新单指标（等价于 series?id&force=1）
 *   GET /api/livelihood/employment/health       健康检查
 *
 * 查询参数（只作用于月度序列，年度序列固定画全历史）：
 *   range=2|5|all           近 N 年 / 全部（2018 起），默认 5
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
  all: { months: 0, label: '全部（2018 起）' },
};

function isMonth(v) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v || '');
}

function resolveRange(query) {
  const history = config.historyRange();
  const from0 = history.month;
  const expected = policy.expectedMonth(new Date());
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
    label: (data.source && data.source.label) || '国家统计局 · 国家数据',
    url: (data.source && data.source.url) || 'https://data.stats.gov.cn',
    chapter: (data.source && data.source.chapter) || '',
    note: (data.source && data.source.note) || '',
  };
  return data;
}

async function indicators() {
  return {
    history: config.historyRange(),
    groups: config.settings().groups,
    presets: presets(),
    indicators: service.describeAll(),
    cache: store.stats(),
    source: config.settings().source,
  };
}

async function one(id, query) {
  const indicator = config.byId(id); // 未知 id 在这里就抛 404，不回源
  const r = resolveRange(query);
  const opts = { force: truthy(query.force) };
  // 年度指标画全历史，区间参数对它无意义
  if (indicator.freq === 'month') {
    opts.from = r.from;
    opts.to = r.to;
  }
  const data = await service.getSeries(id, opts);
  data.range = indicator.freq === 'month' ? { from: r.from, to: r.to, label: r.label } : null;
  return data;
}

function health() {
  const set = service.datasetStatus();
  return { cache: store.stats(), dataset: set, stale: set.behind || !set.catalogs };
}

module.exports = { overview, indicators, one, health, resolveRange, RANGE_PRESET };
