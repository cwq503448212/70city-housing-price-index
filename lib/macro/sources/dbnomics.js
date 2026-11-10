'use strict';

/**
 * 数据源二：DBnomics 开放 API（api.db.nomics.world/v22）
 *
 * 只在主源（国家统计局新版接口）失败时兜底。
 * 注意：DBnomics 镜像的 NBS 月度序列只保留了最近 13 期（抓取时被分页截断），
 * 所以兜底数据一定标 stale=true，前端会显示「数据可能滞后」。
 */

const { createClient } = require('../util/net');
const { serialize, gate, sleep } = require('../util/queue');

const BASE = 'https://api.db.nomics.world/v22';
const GAP_MS = 500;
const client = createClient({ baseUrl: BASE, timeout: 30000, headers: { Accept: 'application/json' } });

/**
 * @param {object} fallback { dataset, series }
 * @returns {Promise<Object>} { [month]: number }
 */
async function fetchSeries(fallback) {
  const dataset = fallback && fallback.dataset;
  const series = fallback && fallback.series;
  if (!dataset || !series) throw new Error('DBnomics 兜底缺少 dataset/series 配置');

  const url = BASE + '/series/NBS/' + encodeURIComponent(dataset) + '/' + encodeURIComponent(series) + '?observations=1';
  let lastErr = null;
  for (let i = 0; i < 2; i += 1) {
    try {
      const json = await serialize(async () => {
        await gate(GAP_MS);
        return client.requestJson(url);
      });
      const doc = ((json && json.series && json.series.docs) || [])[0] || {};
      const periods = doc.period || [];
      const values = doc.value || [];
      const out = {};
      periods.forEach((p, idx) => {
        const m = /^(\d{4})-(\d{2})$/.exec(p);
        if (!m) return;
        const v = values[idx];
        const num = typeof v === 'number' ? v : Number(v);
        if (v === null || v === undefined || v === 'NA' || !isFinite(num)) return;
        out[m[1] + '-' + m[2]] = num;
      });
      if (!Object.keys(out).length) throw new Error('DBnomics 返回空序列');
      return out;
    } catch (e) {
      lastErr = e;
      if (i === 0) await sleep(2000);
    }
  }
  throw new Error('DBnomics 兜底失败：' + (lastErr && lastErr.message ? lastErr.message : '未知错误'));
}

module.exports = { name: 'dbnomics', label: 'DBnomics 镜像', fetchSeries };
