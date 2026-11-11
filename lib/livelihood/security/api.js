'use strict';

/**
 * HTTP 接口层（养老医保）
 *
 *   GET /api/livelihood/security                     看板一次性取全量数据
 *   GET /api/livelihood/security/indicators          指标清单（不含数据）
 *   GET /api/livelihood/security/series/:id          单指标序列
 *   GET /api/livelihood/security/refresh/:id         手动刷新单指标（等价于 series?id&force=1）
 *   GET /api/livelihood/security/health               健康检查
 *
 * 查询参数（年度口径）：
 *   range=10|20|all         近 N 年 / 全部（1990 起，各栏目按自己的起点）
 *   from=YYYY & to=YYYY     自定义区间（优先于 range）
 *   force=1                 跳过缓存，强制回源
 */

const config = require('./config');
const store = require('./store');
const service = require('./service');

const RANGE_PRESET = {
  '10': { years: 10, label: '近 10 年' },
  '20': { years: 20, label: '近 20 年' },
  all: { years: 0, label: '全部（1990 起）' },
};

function isYear(v) {
  return /^\d{4}$/.test(v || '');
}

/** 所有栏目里最晚的应发布年度（各栏目 releaseMonth 相同，取最大值即可） */
const expectedLatest = service.expectedLatestYear;

function resolveRange(query) {
  const history = config.historyRange();
  const expected = expectedLatest(new Date());
  const to = isYear(query.to) && query.to < expected ? query.to : expected;

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
    indicators: service.describeAll(),
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
  return { cache: store.stats(), dataset: set, stale: set.behind || !set.catalogs };
}

module.exports = { overview, indicators, one, health, resolveRange, expectedLatest, RANGE_PRESET };
