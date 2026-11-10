'use strict';

/**
 * HTTP 接口层 + 取数编排
 *
 *   GET /api/lpr/health     健康检查（与 /api/health 的 lpr 字段一致）
 *   GET /api/lpr/overview   全部记录 + 状态（stale / refreshing），支持 force=1
 *
 * 拉取模型（与宏观模块同款思路，按单序列简化）：
 *   - 首次打开（无缓存）→ 同步分段拉全（按年分约 8 段请求，几秒），失败才把空态交给前端；
 *   - 之后每次打开只核对应发布期别：缓存已最新直接返回；已过发布日而缓存滞后 →
 *     先返回缓存（refreshing: true），后台补一次，前端稍后重取；
 *   - 上游失败 → 回退缓存并标 stale:true，不抛 500、不返回空数组。
 */

const config = require('./config');
const store = require('./store');
const policy = require('./policy');
const source = require('./source');

/** 后台补数的 in-flight 去重：并发的多个请求共用同一次回源 */
let inflight = null;

const pad = (n) => String(n).padStart(2, '0');

function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function lastDateOf(records) {
  return records && records.length ? records[records.length - 1].date : null;
}

/**
 * 回源一次并整体覆盖缓存（LPR 全历史才约 90 期，永远整段拉全，不做增量）
 * 是否真的回源由调用方先过 policy 判定。
 */
async function refresh() {
  store.writeMeta({}); // lastAttempt = now，10 分钟冷却从此起算
  try {
    const got = await source.fetchAll(config.HISTORY_FROM, localToday());
    if (!got.records.length) throw new Error('上游返回 0 条记录');
    const prevLatest = lastDateOf(store.read() && store.read().records);
    store.write(got.records, got.source);
    store.writeMeta({
      lastSuccess: new Date().toISOString(),
      lastCount: got.records.length,
      lastError: '',
    });
    const added = got.records.filter((r) => !prevLatest || r.date > prevLatest).length;
    return { added: added, total: got.records.length };
  } catch (e) {
    store.writeMeta({ lastError: e.message });
    throw e;
  }
}

/** 后台补一次，不向调用方抛错（结果写进 meta / 缓存，前端下次取 overview 自然看到） */
function refreshInBackground() {
  if (inflight) return inflight;
  inflight = refresh()
    .then((r) => {
      if (r.added > 0) console.log('[LPR] 已补入 ' + r.added + ' 期，最新 ' + lastDateOf(store.read().records));
    })
    .catch((e) => {
      console.warn('[LPR] 后台核对失败：' + e.message);
    })
    .then(() => {
      inflight = null;
    });
  return inflight;
}

async function overview(query) {
  const force = query && (query.force === '1' || query.force === 'true');

  let cached = store.read();

  // 首次打开（无缓存）：同步一次拉全，等结果
  if (!cached) {
    try {
      await refresh();
      cached = store.read();
    } catch (e) {
      return {
        status: 'empty',
        stale: true,
        refreshing: false,
        error: e.message,
        records: [],
        historyFrom: config.HISTORY_FROM,
        release: config.RELEASE,
        meta: store.readMeta() || {},
      };
    }
  }

  const decision = policy.shouldFetch({ latestDate: lastDateOf(cached.records), meta: store.readMeta(), force });

  let refreshing = false;
  let refreshError = '';
  if (decision.fetch) {
    if (force) {
      // 手动刷新：同步等结果；失败回退缓存（不抛 500）
      try {
        await refresh();
        cached = store.read();
      } catch (e) {
        refreshError = e.message;
      }
    } else {
      refreshing = true;
      refreshInBackground();
    }
  }

  const after = store.read() || cached;
  const records = after.records;
  return {
    status: 'ready',
    stale: policy.isStale(lastDateOf(records)),
    refreshing: refreshing,
    refreshError: refreshError,
    reason: decision.reason,
    source: after.source,
    updatedAt: after.updatedAt,
    historyFrom: config.HISTORY_FROM,
    expectedLatest: decision.expectedLatest,
    release: config.RELEASE,
    records: records,
    meta: store.readMeta() || {},
  };
}

function health() {
  const cache = store.stats();
  return { cache: cache, stale: policy.isStale(cache.lastDate) };
}

module.exports = { overview, health };
