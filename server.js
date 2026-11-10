'use strict';

/**
 * 中国经济统计数据看板 —— 本地服务
 *
 * 一个服务、五个看板，共用同一个端口与静态目录：
 *   房价模块  /housing/    ← 页面    /api/nbs70            ← 数据（国家统计局月报解析）
 *   宏观模块  /macro/      ← 页面    /api/macro/*          ← 数据（国家数据站点，拉全后缓存）
 *   LPR 模块  /lpr/        ← 页面    /api/lpr/*            ← 数据（中国货币网官方 JSON，拉全后缓存）
 *   民生模块  /livelihood/ ← 页面    /api/livelihood/*     ← 数据（国家数据年度库，拉全后缓存）
 *   人均收支  /livelihood/income/ ← 页面 /api/livelihood/income-expenditure ← 数据（同一年度库，独立缓存）
 *   入口页    /            ← 选择进入哪个模块
 *
 * 职责：
 *   1. 提供各看板的 API（服务端取数，规避浏览器跨域与站点 WAF）
 *   2. 托管 public/ 下的静态页面与本地 ECharts
 *
 * 零依赖，只用 Node 内置模块，Node >= 20 即可运行。
 *   node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const nbs70 = require('./lib/housing/nbs70');
const macroConfig = require('./lib/macro/config');
const macroApi = require('./lib/macro/api');
const macroSeries = require('./lib/macro/services/series');
const macroStore = require('./lib/macro/cache/store');
const lprApi = require('./lib/lpr/api');
const livelihoodApi = require('./lib/livelihood/api');
const livelihoodService = require('./lib/livelihood/service');
const incomeApi = require('./lib/livelihood/income/api');
const incomeService = require('./lib/livelihood/income/service');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOUSING_DATASET = path.join(__dirname, 'data', 'periods.json');

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

function housingDatasetInfo() {
  try {
    const st = fs.statSync(HOUSING_DATASET);
    return { file: 'data/periods.json', size: st.size, updatedAt: st.mtime.toISOString() };
  } catch (e) {
    return null;
  }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 目录请求（/housing/）自动补 index.html；不带斜杠的目录（/housing）走 301，
  // 否则页面里的相对路径会以 / 为基准解析错
  const isDirPath = rel.slice(-1) === '/';
  const fileRel = isDirPath ? rel + 'index.html' : rel;
  // 防目录穿越
  const filePath = path.join(PUBLIC_DIR, path.normalize(fileRel).replace(/^(\.\.[\\/])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory() && !isDirPath) {
      res.writeHead(301, { Location: pathname + '/' });
      return res.end();
    }
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

/** 健康检查：各看板的概况（start.bat 也靠它确认端口上确实是本服务） */
function health() {
  return {
    ok: true,
    uptime: process.uptime(),
    now: new Date().toISOString(),
    modules: ['housing', 'macro', 'lpr', 'livelihood', 'livelihood-income'],
    housing: { dataset: housingDatasetInfo() },
    macro: { cache: macroStore.stats(), dataset: macroSeries.datasetStatus() },
    lpr: lprApi.health(),
    livelihood: livelihoodApi.health(),
    livelihoodIncome: incomeApi.health(),
  };
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  const query = parsed.query || {};

  // ---------------- 房价模块（数据已固化为本地数据集，无需异步） ----------------
  if (pathname === '/api/nbs70') {
    let snapshot;
    try {
      snapshot = nbs70.getSnapshot({
        months: query.months || 200,
        force: query.force === '1' || query.force === 'true',
      });
    } catch (e) {
      return sendJson(res, 500, { status: 'error', error: e.message });
    }
    return sendJson(res, 200, snapshot);
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, health());
  }

  // ---------------- 宏观模块（缓存优先：首次拉全，之后只补新一期；接口层是异步的） ----------------
  if (pathname.indexOf('/api/macro/') === 0) {
    const run = async () => {
      if (pathname === '/api/macro/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/macro/indicators') {
        return sendJson(res, 200, await macroApi.indicators());
      }
      if (pathname === '/api/macro/overview') {
        return sendJson(res, 200, await macroApi.overview(query));
      }
      const m = /^\/api\/macro\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await macroApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/macro\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await macroApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
        );
      }
      return sendJson(res, 404, { status: 'error', error: '未知接口 ' + pathname });
    };
    run().catch((e) => {
      // 上游失败不会走到这里（服务层已回退缓存）；
      // 只有「未知指标」这类请求错误（带 status）和配置/代码错误才会落到这里
      sendJson(res, e.status || 500, { status: 'error', error: e.message || String(e) });
    });
    return undefined;
  }

  // ---------------- 人均收入与支出（民生子模块：同一年度库，独立缓存） ----------------
  // 必须排在 /api/livelihood/ 前缀分支之前，否则会被婚育模块的分发吃掉
  if (pathname.indexOf('/api/livelihood/income-expenditure') === 0) {
    const run = async () => {
      if (pathname === '/api/livelihood/income-expenditure/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/livelihood/income-expenditure/indicators') {
        return sendJson(res, 200, await incomeApi.indicators());
      }
      if (pathname === '/api/livelihood/income-expenditure') {
        return sendJson(res, 200, await incomeApi.overview(query));
      }
      const m = /^\/api\/livelihood\/income-expenditure\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await incomeApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/livelihood\/income-expenditure\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await incomeApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
        );
      }
      return sendJson(res, 404, { status: 'error', error: '未知接口 ' + pathname });
    };
    run().catch((e) => {
      // 上游失败不会走到这里（服务层已回退缓存）；
      // 只有「未知指标」这类请求错误（带 status）和配置/代码错误才会落到这里
      sendJson(res, e.status || 500, { status: 'error', error: e.message || String(e) });
    });
    return undefined;
  }

  // ---------------- 民生模块（婚育：国家数据年度库，缓存优先，接口层异步） ----------------
  if (pathname.indexOf('/api/livelihood/') === 0) {
    const run = async () => {
      if (pathname === '/api/livelihood/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/livelihood/indicators') {
        return sendJson(res, 200, await livelihoodApi.indicators());
      }
      if (pathname === '/api/livelihood/overview') {
        return sendJson(res, 200, await livelihoodApi.overview(query));
      }
      const m = /^\/api\/livelihood\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await livelihoodApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/livelihood\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await livelihoodApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
        );
      }
      return sendJson(res, 404, { status: 'error', error: '未知接口 ' + pathname });
    };
    run().catch((e) => {
      // 上游失败不会走到这里（服务层已回退缓存）；
      // 只有「未知指标」这类请求错误（带 status）和配置/代码错误才会落到这里
      sendJson(res, e.status || 500, { status: 'error', error: e.message || String(e) });
    });
    return undefined;
  }

  // ---------------- LPR 模块（房贷利率：中国货币网官方 JSON，缓存优先） ----------------
  if (pathname === '/api/lpr' || pathname.indexOf('/api/lpr/') === 0) {
    const run = async () => {
      if (pathname === '/api/lpr/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/lpr/overview') {
        return sendJson(res, 200, await lprApi.overview(query));
      }
      return sendJson(res, 404, { status: 'error', error: '未知接口 ' + pathname });
    };
    run().catch((e) => {
      // 上游失败不会走到这里（服务层已回退缓存）；
      // 只有配置/代码错误才会落到这里
      sendJson(res, e.status || 500, { status: 'error', error: e.message || String(e) });
    });
    return undefined;
  }

  if (pathname.indexOf('/api/') === 0) {
    return sendJson(res, 404, { status: 'error', error: '未知接口 ' + pathname });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  中国经济统计数据看板已启动');
  console.log('  → http://' + HOST + ':' + PORT);
  console.log('    ├─ 入口（选择模块）  http://' + HOST + ':' + PORT + '/');
  console.log('    ├─ 70 城房价指数     http://' + HOST + ':' + PORT + '/housing/');
  console.log('    ├─ 宏观经济指标      http://' + HOST + ':' + PORT + '/macro/');
  console.log('    ├─ 房贷利率 LPR      http://' + HOST + ':' + PORT + '/lpr/');
  console.log('    ├─ 民生 · 婚育       http://' + HOST + ':' + PORT + '/livelihood/');
  console.log('    └─ 民生 · 人均收支   http://' + HOST + ':' + PORT + '/livelihood/income/');
  const macroSet = macroSeries.datasetStatus();
  console.log('  [宏观] 缓存目录：' + macroSet.dir);
  if (!macroSet.files) {
    console.log('  [宏观] 尚无缓存：首次打开会把 ' + macroSet.historyFrom + ' 起的全部历史一次拉全（半分钟左右）');
  } else if (macroSet.behind) {
    console.log(
      '  [宏观] 已缓存 ' + macroSet.files + ' 个月度文件，最新 ' + macroSet.latest + '；' +
        macroSet.behind + ' 个指标缺最新期别，打开页面时核对'
    );
  } else {
    console.log('  [宏观] 已缓存 ' + macroSet.files + ' 个月度文件，最新 ' + macroSet.latest + '，已对应当月应发布期别');
  }
  console.log('  [房价] 数据集：data/periods.json（本地读取，不联网）');
  const lprSet = lprApi.health();
  if (!lprSet.cache.exists) {
    console.log('  [LPR] 尚无缓存：首次打开页面会把 2019-08 起的全部历史一次拉全（几秒钟）');
  } else {
    console.log(
      '  [LPR] 已缓存 ' + lprSet.cache.count + ' 期，最新 ' + lprSet.cache.lastDate + '（打开页面时按发布日核对）'
    );
  }
  const liveSet = livelihoodService.datasetStatus();
  if (!liveSet.files) {
    console.log('  [民生] 尚无缓存：首次打开会把 ' + liveSet.historyFrom + ' 起的全部年度数据一次拉全（两个请求，几秒钟）');
  } else if (liveSet.behind) {
    console.log(
      '  [民生] 已缓存 ' + liveSet.files + ' 个年度文件，最新 ' + liveSet.latest + '；' +
        liveSet.behind + ' 个指标缺应发布年度，打开页面时核对'
    );
  } else {
    console.log('  [民生] 已缓存 ' + liveSet.files + ' 个年度文件，最新 ' + liveSet.latest + '，已对应当年应发布年度');
  }
  const incomeSet = incomeService.datasetStatus();
  if (!incomeSet.files) {
    console.log('  [民生·收支] 尚无缓存：首次打开会把 ' + incomeSet.historyFrom + ' 起的全部年度数据一次拉全（六个请求，约十秒）');
  } else if (incomeSet.behind) {
    console.log(
      '  [民生·收支] 已缓存 ' + incomeSet.files + ' 个年度文件，最新 ' + incomeSet.latest + '；' +
        incomeSet.behind + ' 个指标缺应发布年度，打开页面时核对'
    );
  } else {
    console.log('  [民生·收支] 已缓存 ' + incomeSet.files + ' 个年度文件，最新 ' + incomeSet.latest + '，已对应当年应发布年度');
  }
  console.log('');

  // 房价模块：直接读 data/periods.json；月份戳不是本月时在后台自动核对一次
  nbs70
    .warmup(200)
    .then((s) => {
      if (s && s.status === 'ready') {
        const d = s.dataset || {};
        console.log(
          '  [房价] ' +
            s.periods.length +
            ' 个月（' +
            (d.firstMonth || '') +
            ' ~ ' +
            (d.lastMonth || '') +
            '），本月已核对'
        );
      } else {
        console.log('  [房价] 首次抓取中，约需 2-4 分钟…');
      }
    })
    .catch((e) => {
      console.warn('  [房价] 预热失败：' + e.message);
    });

  // 宏观模块：只装载配置；数据在首次打开页面时一次拉全，之后只在出现新一期时增补
  try {
    macroConfig.load();
  } catch (e) {
    console.error('  [宏观] 配置有误：' + e.message);
  }

  // 民生模块：同样只装载配置，数据在首次打开页面时一次拉全
  try {
    require('./lib/livelihood/config').load();
  } catch (e) {
    console.error('  [民生] 配置有误：' + e.message);
  }

  // 人均收支子模块：配置独立（config/income.json），取数通道与民生模块共用
  try {
    require('./lib/livelihood/income/config').load();
  } catch (e) {
    console.error('  [民生·收支] 配置有误：' + e.message);
  }
});
