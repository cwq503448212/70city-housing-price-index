'use strict';

/**
 * HTTP 接口层（行业运行）
 *
 *   GET /api/industry              看板一次性取全量数据（41 行业矩阵 + PMI 分项）
 *   GET /api/industry/indicators   指标清单（不含数据，只读缓存）
 *   GET /api/industry/series/:id   单指标序列（id 形如 coal.output / coal.profit / mfg_new_orders）
 *   GET /api/industry/refresh/:id  手动刷新（等价于 series?id&force=1）
 *   GET /api/industry/health       健康检查（只读本地文件，不回源）
 *
 * 查询参数（月度口径）：
 *   range=2|5|all             近 N 年 / 全部（2018 起），默认 5
 *   from=YYYY-MM & to=YYYY-MM 自定义区间（优先于 range）
 *   force=1                   跳过缓存，强制回源
 *
 * 区间的右端点不按单一栏目算：PMI 当月月末就有，工业三个口径要等到下个月中旬，
 * 所以取四个应发布月份里最晚的那个，否则选「近 5 年」时最新一期会被截掉。
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

/** 最晚的那个应发布月份：四个栏目各算各的，取最大 */
function horizon() {
  const base = service.baseByCatalog();
  const list = [base.output, base.revenue, base.profit, service.pmiBase(base)].filter(Boolean).sort();
  return list.length ? list[list.length - 1] : '';
}

function resolveRange(query) {
  const history = config.historyRange();
  const from0 = history.from;
  const expected = horizon();
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
    label: (data.source && data.source.label) || '国家统计局 · 国家数据（月度库）',
    url: (data.source && data.source.url) || 'https://data.stats.gov.cn',
    chapter: (data.source && data.source.chapter) || '工业 / 采购经理指数',
    note: (data.source && data.source.note) || '',
  };
  return data;
}

async function indicators() {
  return {
    history: { from: config.historyRange().from, to: '' },
    groups: config.settings().groups,
    metrics: config.settings().metrics,
    presets: presets(),
    industries: config.industries().map((x) => ({ key: x.key, label: x.label, shortLabel: x.shortLabel, group: x.group })),
    indicators: service.describeAll(),
    cache: store.stats(),
    source: config.settings().source,
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
  return { cache: store.stats(), dataset: set, stale: set.behind > 0 || !set.catalogs };
}

module.exports = { overview, indicators, one, health, resolveRange, RANGE_PRESET, horizon };
