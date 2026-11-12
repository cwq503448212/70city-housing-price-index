'use strict';

/**
 * 中国经济统计数据看板 —— 本地服务
 *
 * 一个服务、十二个看板，共用同一个端口与静态目录：
 *   房价模块  /housing/    ← 页面    /api/nbs70            ← 数据（国家统计局月报解析）
 *   宏观模块  /macro/      ← 页面    /api/macro/*          ← 数据（国家数据站点，拉全后缓存）
 *   LPR 模块  /lpr/        ← 页面    /api/lpr/*            ← 数据（中国货币网官方 JSON，拉全后缓存）
 *   人口与婚育 /livelihood/ ← 页面    /api/livelihood/*     ← 数据（国家数据年度库，拉全后缓存）
 *   人均收支  /livelihood/income/ ← 页面 /api/livelihood/income-expenditure ← 数据（同一年度库，独立缓存）
 *   居民存款  /livelihood/deposit/ ← 页面 /api/livelihood/reserve-deposit ← 数据（央行信贷收支表 + 人口分母）
 *   社会消费品零售 /livelihood/retail/ ← 页面 /api/livelihood/retail ← 数据（国家数据月度库，拉全后缓存）
 *   就业      /livelihood/employment/ ← 页面 /api/livelihood/employment ← 数据（国家数据月度库 + 年度库，拉全后缓存）
 *   养老医保  /livelihood/security/ ← 页面 /api/livelihood/security ← 数据（国家数据年度库，拉全后缓存）
 *   行业运行  /industry/    ← 页面    /api/industry/*        ← 数据（国家数据月度库 · 工业 / PMI，拉全后缓存）
 *   区域经济  /region/      ← 页面    /api/region/*          ← 数据（国家数据分省年度库，逐省请求后缓存）
 *   房地产    /realestate/  ← 页面    /api/realestate/*      ← 数据（国家数据月度库·房地产 + 年度库，拉全后缓存）
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
const depositApi = require('./lib/livelihood/deposit/api');
const depositService = require('./lib/livelihood/deposit/service');
const retailApi = require('./lib/livelihood/retail/api');
const retailService = require('./lib/livelihood/retail/service');
const employmentApi = require('./lib/livelihood/employment/api');
const employmentService = require('./lib/livelihood/employment/service');
const securityApi = require('./lib/livelihood/security/api');
const securityService = require('./lib/livelihood/security/service');
const industryApi = require('./lib/industry/api');
const industryService = require('./lib/industry/service');
const regionApi = require('./lib/region/api');
const realestateApi = require('./lib/realestate/api');
const realestateService = require('./lib/realestate/service');
const forecastApi = require('./lib/forecast/api');
const forecastService = require('./lib/forecast/service');

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

let housingMeta = null; // periods.json 的顶层 meta，只在文件变更时重读

function housingDatasetInfo() {
  try {
    const st = fs.statSync(HOUSING_DATASET);
    if (!housingMeta || housingMeta.mtime !== st.mtimeMs) {
      const data = JSON.parse(fs.readFileSync(HOUSING_DATASET, 'utf8'));
      housingMeta = {
        mtime: st.mtimeMs,
        firstMonth: data.firstMonth,
        lastMonth: data.lastMonth,
        count: data.count,
      };
    }
    return {
      file: 'data/periods.json',
      size: st.size,
      updatedAt: st.mtime.toISOString(),
      firstMonth: housingMeta.firstMonth,
      lastMonth: housingMeta.lastMonth,
      count: housingMeta.count,
    };
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
/**
 * 首页卡片用的新鲜度摘要。各模块 health 的字段口径不一（latest / latestMonth /
 * latestYear / lastDate，behind 有的是期数、有的是布尔），在这里收成一套：
 * { latest, period: 'day'|'month'|'year'|null, behind: 期数|null, stale }
 * behind 为 null 表示只知道落后、期数未定；stale 为 true 表示上游不可达、用的是旧缓存。
 */
function freshness(h) {
  const ds = (h && h.dataset) || {};
  const cache = (h && h.cache) || {};
  const latest = ds.latest || ds.latestMonth || ds.latestYear || ds.lastMonth || cache.lastDate || null;
  let period = null;
  if (latest) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(latest)) period = 'day';
    else if (/^\d{4}-\d{2}$/.test(latest)) period = 'month';
    else if (/^\d{4}$/.test(latest)) period = 'year';
  }
  let behind = ds.behind;
  if (behind === true) behind = null;
  else if (!behind) behind = 0;
  return { latest: latest, period: period, behind: behind, stale: !!(h && h.stale) };
}

function health() {
  const modules = {
    housing: { dataset: housingDatasetInfo() },
    macro: { cache: macroStore.stats(), dataset: macroSeries.datasetStatus() },
    lpr: lprApi.health(),
    livelihood: livelihoodApi.health(),
    livelihoodIncome: incomeApi.health(),
    livelihoodDeposit: depositApi.health(),
    livelihoodRetail: retailApi.health(),
    livelihoodEmployment: employmentApi.health(),
    livelihoodSecurity: securityApi.health(),
    industry: industryApi.health(),
    region: regionApi.health(),
    realestate: realestateApi.health(),
    forecast: forecastApi.health(),
  };
  const fresh = {};
  Object.keys(modules).forEach((k) => {
    fresh[k] = freshness(modules[k]);
  });
  return Object.assign(
    {
      ok: true,
      uptime: process.uptime(),
      now: new Date().toISOString(),
      modules: [
        'housing',
        'macro',
        'lpr',
        'livelihood',
        'livelihood-income',
        'livelihood-deposit',
        'livelihood-retail',
        'livelihood-employment',
        'livelihood-security',
        'industry',
        'region',
        'realestate',
        'forecast',
      ],
      fresh: fresh,
    },
    modules
  );
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

  // ---------------- 区域经济（分省年度库：31 省 GDP，逐省请求后缓存） ----------------
  if (pathname === '/api/region' || pathname.indexOf('/api/region/') === 0) {
    const run = async () => {
      if (pathname === '/api/region/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/region/indicators') {
        return sendJson(res, 200, await regionApi.indicators());
      }
      if (pathname === '/api/region/rank') {
        return sendJson(res, 200, await regionApi.ranking(query));
      }
      if (pathname === '/api/region') {
        return sendJson(res, 200, await regionApi.overview(query));
      }
      const m = /^\/api\/region\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await regionApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/region\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await regionApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
        );
      }
      return sendJson(res, 404, { status: 'error', error: '未知接口 ' + pathname });
    };
    run().catch((e) => {
      // 上游失败不会走到这里（服务层已回退缓存）；
      // 只有「未知指标 / 未知省份」这类请求错误（带 status）和配置/代码错误才会落到这里
      sendJson(res, e.status || 500, { status: 'error', error: e.message || String(e) });
    });
    return undefined;
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

  // ---------------- 行业运行（工业 41 个大类行业 + PMI 分项：国家数据月度库，独立缓存） ----------------
  if (pathname === '/api/industry' || pathname.indexOf('/api/industry/') === 0) {
    const run = async () => {
      if (pathname === '/api/industry/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/industry/indicators') {
        return sendJson(res, 200, await industryApi.indicators());
      }
      if (pathname === '/api/industry') {
        return sendJson(res, 200, await industryApi.overview(query));
      }
      // 指标 id 带点（coal.profit），所以这里不能用 [\w-]
      const m = /^\/api\/industry\/series\/([\w.-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await industryApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/industry\/refresh\/([\w.-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await industryApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
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

  // ---------------- 居民存款与人均存款（民生子模块：央行信贷收支表，独立缓存） ----------------
  // 同样必须排在 /api/livelihood/ 前缀分支之前
  if (pathname.indexOf('/api/livelihood/reserve-deposit') === 0) {
    const run = async () => {
      if (pathname === '/api/livelihood/reserve-deposit/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/livelihood/reserve-deposit/indicators') {
        return sendJson(res, 200, await depositApi.indicators());
      }
      if (pathname === '/api/livelihood/reserve-deposit') {
        return sendJson(res, 200, await depositApi.overview(query));
      }
      const m = /^\/api\/livelihood\/reserve-deposit\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await depositApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/livelihood\/reserve-deposit\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await depositApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
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

  // ---------------- 社会消费品零售（民生子模块：国家数据月度库，独立缓存） ----------------
  // 同样必须排在 /api/livelihood/ 前缀分支之前
  if (pathname.indexOf('/api/livelihood/retail') === 0) {
    const run = async () => {
      if (pathname === '/api/livelihood/retail/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/livelihood/retail/indicators') {
        return sendJson(res, 200, await retailApi.indicators());
      }
      if (pathname === '/api/livelihood/retail') {
        return sendJson(res, 200, await retailApi.overview(query));
      }
      const m = /^\/api\/livelihood\/retail\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await retailApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/livelihood\/retail\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await retailApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
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

  // ---------------- 就业（民生子模块：月度库 + 年度库，独立缓存） ----------------
  // 同样必须排在 /api/livelihood/ 前缀分支之前
  if (pathname.indexOf('/api/livelihood/employment') === 0) {
    const run = async () => {
      if (pathname === '/api/livelihood/employment/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/livelihood/employment/indicators') {
        return sendJson(res, 200, await employmentApi.indicators());
      }
      if (pathname === '/api/livelihood/employment') {
        return sendJson(res, 200, await employmentApi.overview(query));
      }
      const m = /^\/api\/livelihood\/employment\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await employmentApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/livelihood\/employment\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await employmentApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
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

  // ---------------- 养老医保（民生子模块：同一年度库，独立缓存） ----------------
  // 同样必须排在 /api/livelihood/ 前缀分支之前
  if (pathname.indexOf('/api/livelihood/security') === 0) {
    const run = async () => {
      if (pathname === '/api/livelihood/security/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/livelihood/security/indicators') {
        return sendJson(res, 200, await securityApi.indicators());
      }
      if (pathname === '/api/livelihood/security') {
        return sendJson(res, 200, await securityApi.overview(query));
      }
      const m = /^\/api\/livelihood\/security\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await securityApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/livelihood\/security\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await securityApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
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

  // ---------------- 民生模块（人口与婚育：国家数据年度库，缓存优先，接口层异步） ----------------
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

  // ---------------- 房地产开发与销售（独立模块：月度库 + 年度库，独立缓存） ----------------
  if (pathname.indexOf('/api/realestate') === 0) {
    const run = async () => {
      if (pathname === '/api/realestate/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/realestate/indicators') {
        return sendJson(res, 200, await realestateApi.indicators());
      }
      if (pathname === '/api/realestate') {
        return sendJson(res, 200, await realestateApi.overview(query));
      }
      const m = /^\/api\/realestate\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await realestateApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/realestate\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await realestateApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
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

  // ---------------- 人口与住房推演（独立模块：教育 / 人口 / 房地产年度库，独立缓存） ----------------
  if (pathname === '/api/forecast' || pathname.indexOf('/api/forecast/') === 0) {
    const run = async () => {
      if (pathname === '/api/forecast/health') {
        return sendJson(res, 200, health());
      }
      if (pathname === '/api/forecast/indicators') {
        return sendJson(res, 200, await forecastApi.indicators());
      }
      if (pathname === '/api/forecast') {
        return sendJson(res, 200, await forecastApi.overview(query));
      }
      const m = /^\/api\/forecast\/series\/([\w-]+)$/.exec(pathname);
      if (m) {
        return sendJson(res, 200, await forecastApi.one(decodeURIComponent(m[1]), query));
      }
      const r = /^\/api\/forecast\/refresh\/([\w-]+)$/.exec(pathname);
      if (r) {
        return sendJson(
          res,
          200,
          await forecastApi.one(decodeURIComponent(r[1]), Object.assign({}, query, { force: '1' }))
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
  console.log('    ├─ 民生 · 人口与婚育 http://' + HOST + ':' + PORT + '/livelihood/');
  console.log('    ├─ 民生 · 人均收支   http://' + HOST + ':' + PORT + '/livelihood/income/');
  console.log('    ├─ 民生 · 居民存款   http://' + HOST + ':' + PORT + '/livelihood/deposit/');
  console.log('    ├─ 民生 · 社零       http://' + HOST + ':' + PORT + '/livelihood/retail/');
  console.log('    ├─ 民生 · 就业       http://' + HOST + ':' + PORT + '/livelihood/employment/');
  console.log('    ├─ 民生 · 养老医保   http://' + HOST + ':' + PORT + '/livelihood/security/');
  console.log('    ├─ 行业运行          http://' + HOST + ':' + PORT + '/industry/');
  console.log('    ├─ 区域经济          http://' + HOST + ':' + PORT + '/region/');
  console.log('    ├─ 房地产开发与销售  http://' + HOST + ':' + PORT + '/realestate/');
  console.log('    └─ 人口与住房推演    http://' + HOST + ':' + PORT + '/forecast/');
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
    console.log('  [民生] 尚无缓存：首次打开会把 ' + liveSet.historyFrom + ' 起的全部年度数据一次拉全（四个栏目，约五秒）');
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
  const depositSet = depositService.datasetStatus();
  if (!depositSet.months) {
    console.log(
      '  [民生·存款] 尚无缓存：首次打开会把 ' + depositSet.historyFrom + ' 起的全部月度数据一次拉全（约四十个请求，半分钟到一分钟）'
    );
  } else if (depositSet.behind) {
    console.log(
      '  [民生·存款] 已缓存 ' + depositSet.months + ' 个月（' + depositSet.files + ' 个年度文件），最新 ' +
        depositSet.latest + '；应发布 ' + depositSet.expected + '，打开页面时核对'
    );
  } else {
    console.log(
      '  [民生·存款] 已缓存 ' + depositSet.months + ' 个月（' + depositSet.files + ' 个年度文件），最新 ' +
        depositSet.latest + '，已对应当前应发布月份'
    );
  }
  const retailSet = retailService.datasetStatus();
  if (!retailSet.catalogs) {
    console.log(
      '  [民生·社零] 尚无缓存：首次打开会把 ' + retailSet.historyFrom + ' 起的全部月度数据一次拉全（八个栏目，十几秒）'
    );
  } else if (retailSet.behind) {
    console.log(
      '  [民生·社零] 已缓存 ' + retailSet.catalogs + ' 个栏目（' + retailSet.points + ' 个数据点），最新 ' +
        retailSet.latest + '；应发布 ' + retailSet.expected + '，打开页面时核对'
    );
  } else {
    console.log(
      '  [民生·社零] 已缓存 ' + retailSet.catalogs + ' 个栏目（' + retailSet.points + ' 个数据点），最新 ' +
        retailSet.latest + '，已对应当前应发布月份'
    );
  }
  const employSet = employmentService.datasetStatus();
  if (!employSet.catalogs) {
    console.log(
      '  [民生·就业] 尚无缓存：首次打开会把 ' + employSet.historyMonth + ' 起的月度失业率与 ' +
        employSet.historyYear + ' 起的年度农民工一次拉全（三个栏目，几秒钟）'
    );
  } else if (employSet.behind) {
    console.log(
      '  [民生·就业] 已缓存 ' + employSet.catalogs + ' 个栏目（月度 ' + employSet.months + ' 个月 / 年度 ' +
        employSet.years + ' 年），最新月度 ' + (employSet.latestMonth || '—') + '、年度 ' +
        (employSet.latestYear || '—') + '；月度应发布 ' + employSet.expectedMonth + '，打开页面时核对'
    );
  } else {
    console.log(
      '  [民生·就业] 已缓存 ' + employSet.catalogs + ' 个栏目（月度 ' + employSet.months + ' 个月 / 年度 ' +
        employSet.years + ' 年），最新月度 ' + (employSet.latestMonth || '—') + '，已对应当前应发布月份'
    );
  }
  const securitySet = securityService.datasetStatus();
  if (!securitySet.catalogs) {
    console.log(
      '  [民生·养老医保] 尚无缓存：首次打开会把 ' + securitySet.historyFrom +
        ' 起的全部年度数据一次拉全（九个栏目，约十秒）'
    );
  } else if (securitySet.behind) {
    console.log(
      '  [民生·养老医保] 已缓存 ' + securitySet.catalogs + ' 个栏目（' + securitySet.points +
        ' 个数据点），最新 ' + (securitySet.latestYear || '—') + '；' + securitySet.stale +
        ' 个指标缺应发布年度 ' + securitySet.expectedYear + '，打开页面时核对'
    );
  } else {
    console.log(
      '  [民生·养老医保] 已缓存 ' + securitySet.catalogs + ' 个栏目（' + securitySet.points +
        ' 个数据点），最新 ' + (securitySet.latestYear || '—') + '，已对应当年应发布年度'
    );
  }
  const industrySet = industryService.datasetStatus();
  if (!industrySet.catalogs) {
    console.log(
      '  [行业运行] 尚无缓存：首次打开会把 ' + industrySet.historyFrom + ' 起的 ' + industrySet.industries +
        ' 个行业三口径与 PMI 分项一次拉全（五个栏目，约十秒）'
    );
  } else if (industrySet.behind) {
    console.log(
      '  [行业运行] 已缓存 ' + industrySet.catalogs + ' 个栏目（' + industrySet.points +
        ' 个数据点），最新 ' + (industrySet.latest || '—') + '；工业应发布 ' + industrySet.expected +
        '、PMI 应发布 ' + industrySet.expectedPmi + '，打开页面时核对'
    );
  } else {
    console.log(
      '  [行业运行] 已缓存 ' + industrySet.catalogs + ' 个栏目（' + industrySet.points +
        ' 个数据点），最新 ' + (industrySet.latest || '—') + '，已对应当前应发布月份'
    );
  }
  const regionSet = regionApi.health().dataset;
  if (!regionSet.provinces) {
    console.log(
      '  [区域经济] 尚无缓存：首次打开会把 ' + regionSet.historyFrom + ' 起的 ' + regionSet.total +
        ' 个省份地区生产总值逐省拉全（约四十秒），官方指数随后后台补齐'
    );
  } else if (regionSet.behind) {
    console.log(
      '  [区域经济] 已缓存 ' + regionSet.provinces + ' 个省份（' + regionSet.points +
        ' 个数据点），最新 ' + (regionSet.latestYear || '—') + '；缺应发布年度 ' +
        regionSet.expectedYear + '，打开页面时核对'
    );
  } else {
    console.log(
      '  [区域经济] 已缓存 ' + regionSet.provinces + ' 个省份（' + regionSet.points +
        ' 个数据点），最新 ' + (regionSet.latestYear || '—') + '，已对应当年应发布年度'
    );
  }
  const estateSet = realestateService.datasetStatus();
  if (!estateSet.catalogs) {
    console.log(
      '  [房地产] 尚无缓存：首次打开会把 ' + estateSet.historyMonth + ' 起的月度 12 个栏目与 ' +
        estateSet.historyYear + ' 起的年度 10 个栏目一次拉全（22 次请求，约半分钟）'
    );
  } else if (estateSet.behind) {
    console.log(
      '  [房地产] 已缓存 ' + estateSet.catalogs + ' 个栏目（月度 ' + estateSet.months + ' 个月 / 年度 ' +
        estateSet.years + ' 年），最新月度 ' + (estateSet.latestMonth || '—') + '、年度 ' +
        (estateSet.latestYear || '—') + '；月度应发布 ' + estateSet.expectedMonth + '，打开页面时核对'
    );
  } else {
    console.log(
      '  [房地产] 已缓存 ' + estateSet.catalogs + ' 个栏目（月度 ' + estateSet.months + ' 个月 / 年度 ' +
        estateSet.years + ' 年），最新月度 ' + (estateSet.latestMonth || '—') + '，已对应当前应发布月份'
    );
  }
  const forecastSet = forecastService.datasetStatus();
  if (!forecastSet.files) {
    console.log(
      '  [推演] 尚无缓存：首次打开会把 ' + forecastSet.historyFrom +
        ' 起的人口、教育与房地产年度数据一次拉全（七个栏目，约十秒）'
    );
  } else if (forecastSet.behind) {
    console.log(
      '  [推演] 已缓存 ' + forecastSet.files + ' 个年度文件，最新 ' + forecastSet.latest + '；' +
        forecastSet.behind + ' 个指标缺应发布年度，打开页面时核对'
    );
  } else {
    console.log(
      '  [推演] 已缓存 ' + forecastSet.files + ' 个年度文件，最新 ' + forecastSet.latest + '，已对应当年应发布年度'
    );
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

  // 居民存款子模块：配置独立（config/deposit.json），月度表走央行、人口分母走国家数据
  try {
    require('./lib/livelihood/deposit/config').load();
  } catch (e) {
    console.error('  [民生·存款] 配置有误：' + e.message);
  }

  // 社会消费品零售子模块：配置独立（config/retail.json），走国家数据月度库
  try {
    require('./lib/livelihood/retail/config').load();
  } catch (e) {
    console.error('  [民生·社零] 配置有误：' + e.message);
  }

  // 就业子模块：配置独立（config/employment.json），月度失业率走月度库、农民工与登记失业走年度库
  try {
    require('./lib/livelihood/employment/config').load();
  } catch (e) {
    console.error('  [民生·就业] 配置有误：' + e.message);
  }

  // 养老医保子模块：配置独立（config/security.json），九张年度表全走国家数据年度库
  try {
    require('./lib/livelihood/security/config').load();
  } catch (e) {
    console.error('  [民生·养老医保] 配置有误：' + e.message);
  }

  // 行业运行模块：配置独立（config/industry.json），工业三口径 + PMI 分项全走国家数据月度库
  try {
    require('./lib/industry/config').load();
  } catch (e) {
    console.error('  [行业运行] 配置有误：' + e.message);
  }

  // 区域经济模块：配置独立（config/region.json），31 省 GDP 走国家数据分省年度库
  try {
    require('./lib/region/config').load();
  } catch (e) {
    console.error('  [区域经济] 配置有误：' + e.message);
  }

  // 房地产开发与销售模块：配置独立（config/realestate.json），月度库房地产 + 年度库固定资产投资和房地产
  try {
    require('./lib/realestate/config').load();
  } catch (e) {
    console.error('  [房地产] 配置有误：' + e.message);
  }

  // 人口与住房推演模块：配置独立（config/forecast.json），人口 / 教育 / 房地产三个年度栏目
  try {
    require('./lib/forecast/config').load();
  } catch (e) {
    console.error('  [推演] 配置有误：' + e.message);
  }
});
