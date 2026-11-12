'use strict';

/**
 * 极简限流：所有对外请求串行 + 全局最小间隔 + 同一栏目 60 秒冷却。
 *
 * 统计局站点对高频访问很敏感（连发请求会回 WAF 302/403），宁可慢一点也不要并发。
 * 与民生模块的 livelihood/queue 同款语义，但按模块边界各留一份（模块之间不互相 require）。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tail = Promise.resolve();

/** 串行执行：所有对外网络请求都必须包在这里面 */
function serialize(task) {
  const run = tail.then(task, task);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const lastAt = new Map();

async function cooldown(key, ms) {
  const prev = lastAt.get(key) || 0;
  const wait = prev + ms - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt.set(key, Date.now());
}

/** 全局最小请求间隔：任何两次对外请求之间至少隔 ms 毫秒 */
async function gate(ms) {
  await cooldown('__global__', ms);
}

/** 冷却期内直接跳过（不等待），用于「同一栏目 60 秒内不重复拉取」 */
function blocked(key, ms) {
  const prev = lastAt.get(key) || 0;
  return Date.now() - prev < ms;
}

function mark(key) {
  lastAt.set(key, Date.now());
}

function snapshot() {
  const out = {};
  for (const [k, v] of lastAt.entries()) out[k] = new Date(v).toISOString();
  return out;
}

module.exports = { serialize, cooldown, gate, blocked, mark, sleep, snapshot };
