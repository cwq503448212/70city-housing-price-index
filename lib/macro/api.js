'use strict';

/**
 * HTTP 接口层
 *
 *   GET /api/macro/health              健康检查
 *   GET /api/macro/indicators          指标清单（不含数据）
 *   GET /api/macro/overview            看板一次性取全量数据（顶部时间选择 -> 全图联动）
 *   GET /api/macro/series/:id          单指标序列
 *   GET /api/macro/refresh/:id         手动刷新单指标（等价于 series?id&force=1）
 *
 * 查询参数：
 *   range=12|36|60|120|all   近 N 个月 / 全部
 *   from=YYYY-MM & to=YYYY-MM  自定义区间（优先于 range）
 *   force=1                   跳过缓存，强制回源
 */

const config = require('./config');
const month = require('./util/month');
const policy = require('./cache/policy');
const store = require('./cache/store');
const series = require('./services/series');

const RANGE_PRESET = {
  '12': { months: 12, label: '近 1 年' },
  '36': { months: 36, label: '近 3 年' },
  '60': { months: 60, label: '近 5 年' },
  '120': { months: 120, label: '近 10 年' },
  all: { months: 0, label: '全部' },
};

function resolveRange(query) {
  const history = config.historyRange();
  const expectedLatest = policy.expectedLatestMonth({ day: 9 }, new Date());
  const to = /^\d{4}-\d{2}$/.test(query.to || '') ? query.to : expectedLatest;

  if (/^\d{4}-\d{2}$/.test(query.from || '')) {
    return { from: query.from > history.from ? query.from : history.from, to: to, label: '自定义' };
  }
  const key = String(query.range || '60');
  const preset = RANGE_PRESET[key] || RANGE_PRESET['60'];
  if (!preset.months) return { from: history.from, to: to, label: preset.label };
  const from = month.addMonths(to, -(preset.months - 1));
  return { from: from > history.from ? from : history.from, to: to, label: preset.label };
}

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

async function overview(query) {
  const r = resolveRange(query);
  const force = truthy(query.force);
  const data = await series.overview({ from: r.from, to: r.to, force: force });
  data.range.label = r.label;
  data.presets = Object.keys(RANGE_PRESET).map((k) => ({ key: k, label: RANGE_PRESET[k].label }));
  data.history = config.historyRange();
  return data;
}

async function indicators() {
  return {
    history: config.historyRange(),
    groups: config.settings().groups,
    presets: Object.keys(RANGE_PRESET).map((k) => ({ key: k, label: RANGE_PRESET[k].label })),
    indicators: config.list().map((ind) => series.descriptor(ind)),
    cache: store.stats(),
  };
}

async function one(id, query) {
  const r = resolveRange(query);
  const data = await series.getSeries(id, { from: r.from, to: r.to, force: truthy(query.force) });
  data.range = { from: r.from, to: r.to, label: r.label };
  return data;
}

module.exports = { overview, indicators, one, resolveRange, RANGE_PRESET };
