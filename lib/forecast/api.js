'use strict';

/**
 * HTTP 接口层
 *
 *   GET /api/forecast/health       健康检查
 *   GET /api/forecast/indicators   指标清单（不含数据）
 *   GET /api/forecast              看板一次性取全量：历史原值 + 三情景推演 + 回测
 *   GET /api/forecast/series/:id   单指标历史序列
 *   GET /api/forecast/refresh/:id  手动刷新单指标（等价于 series?id&force=1）
 *
 * 查询参数：
 *   chartFrom=YYYY   图上历史起点（默认 2000，教育 / 房地产栏目自 2000 起）
 *   force=1          跳过缓存，强制回源
 */

const config = require('./config');
const store = require('./store');
const service = require('./service');

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

function isYear(v) {
  return /^\d{4}$/.test(v || '');
}

async function overview(query) {
  const chartFrom = isYear(query.chartFrom) && query.chartFrom >= config.historyRange().from ? query.chartFrom : '2000';
  const data = await service.overview({ chartFrom: chartFrom, force: truthy(query.force) });
  data.source = config.settings().source;
  data.site = config.settings().site;
  data.history = config.historyRange();
  data.horizon = config.model().horizon;
  return data;
}

async function indicators() {
  return {
    history: config.historyRange(),
    groups: config.settings().groups,
    model: config.model(),
    indicators: config.list().map((ind) => service.descriptor(ind)),
    cache: store.stats(),
  };
}

async function one(id, query) {
  return service.getSeries(id, { force: truthy(query.force) });
}

function health() {
  const set = service.datasetStatus();
  return { cache: store.stats(), dataset: set, stale: set.behind > 0 || !set.files };
}

module.exports = { overview, indicators, one, health };
