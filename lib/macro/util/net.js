'use strict';

/**
 * 极简 HTTP 客户端（Node 原生 http/https，零依赖）
 *
 * 只做四件事：
 *   1. 统一 UA / Referer / 超时（国家数据站点会校验来源页）
 *   2. 维护站点级 Cookie（WAF 会下发会话 Cookie，带上能少踩 302）
 *   3. 跟随最多 3 次重定向
 *   4. 把响应体统一成 Buffer 再自行按 UTF-8 解码
 *
 * 不做重试：重试策略在 sources/ 里按数据源语义决定。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function createClient(options) {
  const opts = options || {};
  const timeout = opts.timeout || 30000;
  const defaultHeaders = Object.assign(
    {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
    },
    opts.headers || {}
  );
  const jar = Object.create(null);

  function cookieHeader() {
    const keys = Object.keys(jar);
    return keys.length ? keys.map((k) => k + '=' + jar[k]).join('; ') : '';
  }

  function abs(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    if (!opts.baseUrl) throw new Error('相对路径需要 baseUrl: ' + pathOrUrl);
    return opts.baseUrl.replace(/\/$/, '') + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
  }

  function once(pathOrUrl, options2) {
    const target = abs(pathOrUrl);
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(target);
      } catch (e) {
        return reject(new Error('非法 URL: ' + target));
      }
      const lib = u.protocol === 'https:' ? https : http;
      const headers = Object.assign({}, defaultHeaders, options2.headers || {});
      const cookie = cookieHeader();
      if (cookie) headers.Cookie = cookie;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          method: options2.method || 'GET',
          headers,
          timeout,
        },
        (res) => {
          (res.headers['set-cookie'] || []).forEach((c) => {
            const kv = c.split(';')[0];
            const i = kv.indexOf('=');
            if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
          });
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('请求超时（' + Math.round(timeout / 1000) + 's）: ' + target)));
      req.on('error', reject);
      if (options2.body) req.write(options2.body);
      req.end();
    });
  }

  async function request(pathOrUrl, options2) {
    const o = options2 || {};
    let res = await once(pathOrUrl, o);
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && res.headers.location && hops < 3) {
      hops += 1;
      const next = new URL(res.headers.location, abs(pathOrUrl)).href;
      res = await once(next, o);
    }
    return res;
  }

  async function requestJson(pathOrUrl, options2) {
    const res = await request(pathOrUrl, options2);
    const text = res.body.toString('utf8');
    if (res.status !== 200) {
      throw new HttpError('HTTP ' + res.status + ' ' + abs(pathOrUrl), res.status, text.slice(0, 200));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new HttpError('响应不是 JSON: ' + abs(pathOrUrl), res.status, text.slice(0, 200));
    }
  }

  return { request, requestJson, headers: defaultHeaders };
}

module.exports = { createClient, HttpError, UA };
