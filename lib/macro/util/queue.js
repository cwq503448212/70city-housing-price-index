'use strict';

/**
 * 全局限流：同一时刻只允许 1 个对外请求，且同一指标 60 秒内不重复拉取。
 *
 * 统计局站点对高频访问很敏感（连续请求会返回 WAF 302/403），
 * 所以宁可慢一点，也不要并发。
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

/**
 * 冷却等待：key 上次执行时间距今不足 ms 时先等够
 * @param {string} key
 * @param {number} ms
 */
async function cooldown(key, ms) {
  const prev = lastAt.get(key) || 0;
  const wait = prev + ms - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt.set(key, Date.now());
}

/**
 * 全局最小请求间隔：任何两次对外请求之间至少隔 ms 毫秒
 * （统计局站点连发请求会吃 WAF，串行之外还要拉开时间）
 */
async function gate(ms) {
  await cooldown('__global__', ms);
}

/**
 * 冷却期内直接跳过（不等待），用于「同一指标 60 秒内不重复拉取」
 */
function blocked(key, ms) {
  const prev = lastAt.get(key) || 0;
  return Date.now() - prev < ms;
}

function mark(key) {
  lastAt.set(key, Date.now());
}

/** 供测试/调试查看当前冷却表 */
function snapshot() {
  const out = {};
  for (const [k, v] of lastAt.entries()) out[k] = new Date(v).toISOString();
  return out;
}

module.exports = { serialize, cooldown, gate, blocked, mark, sleep, snapshot };
