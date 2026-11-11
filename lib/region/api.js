'use strict';

/**
 * HTTP 接口层（区域经济 · 分省 GDP）
 *
 *   GET /api/region                                   看板一次性取全量数据
 *   GET /api/region/indicators                        指标清单 + 省份表（不含序列）
 *   GET /api/region/series/:id?provinces=11,44        单指标多省序列
 *   GET /api/region/rank?metric=gdp&year=2025         横截面排名
 *   GET /api/region/refresh/:id                       手动刷新单指标（等价于 series?id&force=1）
 *   GET /api/region/health                            健康检查
 *
 * 查询参数（年度口径）：
 *   range=10|20|all         近 N 年 / 全部（1992 起）
 *   from=YYYY & to=YYYY     自定义区间（优先于 range）
 *   provinces=11,44,广东     省码前两位 / 简称 / 全称 / 12 位码，逗号分隔；缺省为全部 31 省
 *   force=1                 跳过缓存，强制回源
 */

const config = require('./config');
const store = require('./store');
const service = require('./service');

const RANGE_PRESET = {
  '10': { years: 10, label: '近 10 年' },
  '20': { years: 20, label: '近 20 年' },
  all: { years: 0, label: '全部（1992 起）' },
};

function isYear(v) {
  return /^\d{4}$/.test(v || '');
}

/** 所有栏目里最晚的应发布年度 */
const expectedLatest = service.expectedYear;

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
  data.range.label = r.label;
  data.presets = presets();
  data.rangeLabel = r.label;
  return data;
}

async function indicators() {
  const settings = config.settings();
  const cached = config.load();
  return {
    history: config.historyRange(),
    expectedYear: expectedLatest(new Date()),
    releaseMonth: settings.releaseMonth,
    groups: settings.groups,
    presets: presets(),
    provinces: config.provinces(),
    indicators: service.describeAll(),
    source: cached.source || {},
    cache: store.stats(),
  };
}

async function one(id, query) {
  const r = resolveRange(query);
  const data = await service.getSeries(id, {
    from: r.from,
    to: r.to,
    provinces: query.provinces,
    force: truthy(query.force),
  });
  data.range = { from: r.from, to: r.to, label: r.label };
  return data;
}

async function ranking(query) {
  const metric = query.metric || 'gdp';
  const data = await service.rank(metric, {
    year: query.year,
    force: truthy(query.force),
  });
  data.range = resolveRange({ from: query.from, to: query.to });
  return data;
}

function health() {
  const set = service.datasetStatus();
  return { cache: store.stats(), dataset: set, stale: set.behind || !set.provinces };
}

module.exports = { overview, indicators, one, ranking, health, resolveRange, expectedLatest, RANGE_PRESET };
