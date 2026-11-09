'use strict';

/**
 * 70 城房价看板 —— 本地服务
 *
 * 职责：
 *   1. 提供 /api/nbs70 数据接口（服务端抓取国家统计局数据，规避浏览器跨域）
 *   2. 托管 public/ 下的静态页面
 *
 * 零依赖，直接用 Node 内置模块，Node >= 12 即可运行。
 *   node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const nbs70 = require('./lib/nbs70');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + rel);
    }
    const ext = path.extname(filePath).toLowerCase();
    const isVendor = /[\\/]vendor[\\/]/.test(filePath);
    // 带上验证器，改完前端文件刷新就能拿到新的（否则 no-cache 无处 revalidate）
    const etag = 'W/"' + stat.size.toString(16) + '-' + stat.mtime.getTime().toString(16) + '"';
    const lastModified = stat.mtime.toUTCString();
    if (!isVendor) {
      const inm = req.headers['if-none-match'];
      const ims = req.headers['if-modified-since'];
      if (inm ? inm === etag : ims && new Date(ims) >= stat.mtime - 1000) {
        res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' });
        return res.end();
      }
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (pathname === '/api/nbs70') {
    const q = parsed.query || {};
    let snapshot;
    try {
      snapshot = nbs70.getSnapshot({
        months: q.months || 200,
        force: q.force === '1' || q.force === 'true',
      });
    } catch (e) {
      return sendJson(res, 500, { status: 'error', error: e.message });
    }
    return sendJson(res, 200, snapshot);
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, uptime: process.uptime() });
  }

  if (pathname.indexOf('/api/') === 0) {
    return sendJson(res, 404, { status: 'error', error: '未知接口 ' + pathname });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  70 城房价看板已启动');
  console.log('  → http://' + HOST + ':' + PORT);
  console.log('  数据源：国家统计局 · 数据发布（www.stats.gov.cn）');
  console.log('');
  // 直接读 data/periods.json；月份戳不是本月时会在后台自动核对一次
  nbs70
    .warmup(200)
    .then((s) => {
      if (s && s.status === 'ready') {
        const d = s.dataset || {};
        console.log(
          '  [数据集] ' +
            s.periods.length +
            ' 个月（' +
            (d.firstMonth || '') +
            ' ~ ' +
            (d.lastMonth || '') +
            '），本月已核对'
        );
      } else {
        console.log('  [预热] 首次抓取中，约需 2-4 分钟…');
      }
    })
    .catch((e) => {
      console.warn('  [预热] 失败：' + e.message);
    });
});
