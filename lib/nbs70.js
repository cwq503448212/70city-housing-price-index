'use strict';

/**
 * 国家统计局 70 个大中城市商品住宅销售价格指数 —— 采集与解析
 *
 * 数据来源：https://www.stats.gov.cn/sj/zxfb/  每月发布的
 *   《XX年X月份70个大中城市商品住宅销售价格变动情况》
 * 该页面未被 WAF 拦截，且正文内嵌完整的 70 城表格，因此直接解析 HTML 最稳定。
 *
 * 缓存：解析结果落盘到 .cache/，避免重复抓取大页面（单篇约 1.3MB）。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SITE = 'https://www.stats.gov.cn';
const LIST_PATH = '/sj/zxfb/';
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const INDEX_CACHE = path.join(CACHE_DIR, 'index.json');
/** 月报原文缓存：解析器改动后可以直接本地重解析，不用再走网络 */
const RAW_DIR = path.join(CACHE_DIR, 'raw');
/** 随项目分发的本地数据集：抓一次就固化下来，之后启动完全不联网 */
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATASET_FILE = path.join(DATA_DIR, 'periods.json');

const SOURCE_INFO = {
  name: '国家统计局 · 数据发布',
  listUrl: SITE + LIST_PATH,
  note: '数据为「70 个大中城市商品住宅销售价格变动情况」逐月发布内容，指数以上月/上年同月＝100 为基准。',
};

/** 站内搜索接口（国务院办公厅搜索平台），能检索到 2011 年以来的全部月报 */
const SEARCH_API = 'https://api.so-gov.cn/query/s';
const SITE_CODE = 'bm36000002';
const SEARCH_QT = '70个大中城市商品住宅销售价格变动情况';

/** 2016 年及以后标题带“商品”，2011-2015 年为“住宅销售价格变动情况”；
 *  2016 年 10-12 月曾加挂“及 15 个一线和热点二线城市” */
const ARTICLE_TITLE_RE =
  /(\d{4})年(\d{1,2})月份70个大中城市[^，。]{0,26}住宅销售价格变动情况/;

/** 城市名只能是纯汉字（2-6 字），用于过滤表头行如「上月=100」 */
const CITY_NAME_RE = /^[\u4e00-\u9fa5]{2,6}$/;

/** 解析器版本：调整解析逻辑后递增，旧缓存会自动失效 */
const PARSER_VERSION = 4;

/** 一线城市（国家统计局口径） */
const TIER1 = ['北京', '上海', '广州', '深圳'];
/** 二线城市（国家统计局口径，共 31 个） */
const TIER2 = [
  '天津', '石家庄', '太原', '呼和浩特', '沈阳', '大连', '长春', '哈尔滨',
  '南京', '杭州', '宁波', '合肥', '福州', '厦门', '南昌', '济南', '青岛',
  '郑州', '武汉', '长沙', '南宁', '海口', '重庆', '成都', '贵阳', '昆明',
  '西安', '兰州', '西宁', '银川', '乌鲁木齐',
];

// ---------------------------------------------------------------- 基础工具

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带 gzip 解压与重定向跟随的 GET */
function fetchText(url, redirects) {
  const hop = redirects || 0;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('非法 URL: ' + url));
    }
    const lib = u.protocol === 'https:' ? https : require('http');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'keep-alive',
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hop < 5) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return fetchText(next, hop + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          } catch (e) {
            /* 已经是明文则忽略 */
          }
          resolve(buf.toString('utf8'));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时: ' + url)));
    req.on('error', reject);
    req.end();
  });
}

/** 带 gzip 解压的 POST 表单请求（用于站内搜索接口） */
function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const body = Object.keys(form)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k]))
      .join('&');
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          Origin: SITE,
          Referer: SITE + '/search/s?qt=test',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          } catch (e) {
            /* 已经是明文则忽略 */
          }
          resolve(buf.toString('utf8'));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时: ' + url)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

/**
 * 月报原文缓存（gzip）
 * 单篇原文 1.3MB，gzip 后约 150KB，189 个月一共 30MB 量级。
 * 好处：调解析器时只需递增 PARSER_VERSION，重算走本地原文，零网络请求。
 */
function rawFile(month) {
  return path.join(RAW_DIR, 'month-' + month + '.html.gz');
}

function readRaw(month) {
  try {
    return zlib.gunzipSync(fs.readFileSync(rawFile(month))).toString('utf8');
  } catch (e) {
    return null;
  }
}

function writeRaw(month, html) {
  try {
    fs.writeFileSync(rawFile(month), zlib.gzipSync(Buffer.from(html, 'utf8')));
  } catch (e) {
    // 原文写盘失败不影响本次解析
  }
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function cellText(s) {
  return stripTags(s).replace(/\s+/g, '').trim();
}

function cityTier(name) {
  if (TIER1.indexOf(name) >= 0) return 1;
  if (TIER2.indexOf(name) >= 0) return 2;
  return 3;
}

// ---------------------------------------------------------------- 列表页解析

/** 从列表页 HTML 中提取 70 城文章链接 */
function extractArticles(html, pageUrl) {
  const out = [];
  const seen = {};
  // 列表项形如：<a class="fl pc_1600" href="./202610/t20261019_1965609.html" title='...'>
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*title=['"]([^'"]*)['"]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const title = m[2];
    const tm = ARTICLE_TITLE_RE.exec(title);
    if (!tm) continue;
    const abs = new URL(href, pageUrl).href;
    if (seen[abs]) continue;
    seen[abs] = true;
    const year = Number(tm[1]);
    const month = Number(tm[2]);
    const pub = /t(\d{4})(\d{2})(\d{2})_/.exec(href);
    out.push({
      month: year + '-' + String(month).padStart(2, '0'),
      title: title,
      url: abs,
      publishedAt: pub ? pub[1] + '-' + pub[2] + '-' + pub[3] : null,
    });
  }
  return out;
}

/**
 * 扫描“数据发布”列表页，收集最近若干个月的 70 城文章。
 * 列表页顺序为倒序，第 1 页为列表根路径，之后为 index_1.html、index_2.html ...
 * 注意：静态分页只到 2021-11（index_66），更早的数据只能用站内搜索索引。
 */
async function scanListPages(want) {
  const found = [];
  const seenUrl = {};
  const maxPages = 70;
  let emptyStreak = 0;
  for (let p = 0; p < maxPages; p++) {
    const pageUrl = SITE + LIST_PATH + (p === 0 ? '' : 'index_' + p + '.html');
    let html;
    try {
      html = await fetchText(pageUrl);
    } catch (e) {
      if (p === 0) throw e;
      break; // 后面的翻页不存在
    }
    const items = extractArticles(html, pageUrl);
    let added = 0;
    for (const it of items) {
      if (seenUrl[it.url]) continue;
      seenUrl[it.url] = true;
      found.push(it);
      added++;
    }
    emptyStreak = added === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 6) break; // 个别列表页恰好没有 70 城条目
    if (want && found.length >= want + 2) break;
    await sleep(60);
  }
  return found;
}

// ---------------------------------------------------------------- 站内搜索索引

/** 把搜索结果文档归一成 { month, title, url, publishedAt }，非月报返回 null */
function normalizeSearchDoc(doc) {
  const data = (doc && doc.data) || {};
  const title = stripTags(data.titleO || data.title || '').trim();
  const m = ARTICLE_TITLE_RE.exec(title);
  if (!m) return null;
  const url = String(data.url || '').replace(/^http:/, 'https:');
  if (!url) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!(year >= 2011 && year <= 2100) || !(month >= 1 && month <= 12)) return null;
  const pub = /t(\d{4})(\d{2})(\d{2})_/.exec(url);
  return {
    month: year + '-' + String(month).padStart(2, '0'),
    title: title,
    url: url,
    publishedAt: pub ? pub[1] + '-' + pub[2] + '-' + pub[3] : null,
  };
}

async function searchPage(qt, page) {
  const raw = await postForm(SEARCH_API, {
    siteCode: SITE_CODE,
    tab: '',
    qt: qt,
    page: page,
    pageSize: 20,
  });
  const j = JSON.parse(raw);
  return { docs: (j && j.resultDocs) || [], totalHits: (j && j.totalHits) || 0 };
}

/** 针对单个缺失月份精确检索；命中不到时再查 2016 年那批长标题 */
async function searchOneMonth(year, month) {
  const key = year + '-' + String(month).padStart(2, '0');
  const queries = [year + '年' + month + '月份70个大中城市住宅销售价格变动情况'];
  try {
    for (const qt of queries) {
      const r = await searchPage(qt, 1);
      for (const d of r.docs) {
        const it = normalizeSearchDoc(d);
        if (it && it.month === key) return it;
      }
      await sleep(200);
    }
  } catch (e) {
    /* 单个月份失败不影响整体 */
  }
  // 2016 年 9-11 月的标题是“及 X 月上半月/下半月一线和热点二线城市…”，主查询命中不到
  const alt = await altIndex();
  for (const it of alt) {
    if (it.month === key) return it;
  }
  return null;
}

/** 备用索引：2016 年 10 月起标题加挂了“及 X 月上半月/下半月一线和热点二线城市” */
let altCache = null;
async function altIndex() {
  if (altCache) return altCache;
  const list = [];
  const qt = '70个大中城市及15个一线和热点二线城市住宅销售价格变动情况';
  try {
    for (let page = 1; page <= 4; page++) {
      const r = await searchPage(qt, page);
      if (!r.docs.length) break;
      for (const d of r.docs) {
        const it = normalizeSearchDoc(d);
        if (it) list.push(it);
      }
      if (page * r.docs.length >= r.totalHits) break;
      await sleep(200);
    }
  } catch (e) {
    /* 忽略 */
  }
  altCache = list;
  return list;
}

/** 列出起止月份之间缺失的月份 */
function findMonthGaps(byMonth) {
  const keys = Object.keys(byMonth).sort();
  if (keys.length < 2) return [];
  const start = keys[0].split('-').map(Number);
  const end = keys[keys.length - 1].split('-').map(Number);
  const gaps = [];
  let y = start[0];
  let m = start[1];
  while (y < end[0] || (y === end[0] && m <= end[1])) {
    const k = y + '-' + String(m).padStart(2, '0');
    if (!byMonth[k]) gaps.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return gaps;
}

/**
 * 通过站内搜索拿到全部历史月报（2011 年至今）。
 * 列表页只有到 2021-11，更早的月份只能靠这个索引。
 */
async function searchArticleIndex() {
  const byMonth = {};
  let lastMonths = 0;
  let stale = 0;
  for (let page = 1; page <= 45; page++) {
    const r = await searchPage(SEARCH_QT, page);
    if (!r.docs.length) break;
    for (const d of r.docs) {
      const it = normalizeSearchDoc(d);
      if (!it) continue;
      const cur = byMonth[it.month];
      if (!cur) {
        byMonth[it.month] = it;
      } else if (/\/202302\//.test(cur.url) && !/\/202302\//.test(it.url)) {
        byMonth[it.month] = it; // 优先保留原始发布页，而非批量迁移的归档页
      }
    }
    const n = Object.keys(byMonth).length;
    stale = n === lastMonths ? stale + 1 : 0;
    lastMonths = n;
    if (stale >= 3) break; // 后面几页都是重复结果
    if (page * r.docs.length >= r.totalHits) break;
    await sleep(260);
  }

  for (const g of findMonthGaps(byMonth)) {
    const it = await searchOneMonth(g.year, g.month);
    if (it && !byMonth[it.month]) byMonth[it.month] = it;
    await sleep(260);
  }

  return Object.keys(byMonth).map((k) => byMonth[k]);
}

/**
 * 只翻搜索结果的前两页（最新的几十条），合并进已有索引。
 *
 * 新发布的月报必定排在搜索结果最前面，没必要为了一个月重翻 45 页（那要 60 秒）。
 * 本地还没有索引底档时返回 null，交给完整的 searchArticleIndex。
 */
async function refreshIndexHead() {
  const cached = readJson(INDEX_CACHE);
  const base =
    cached && cached.schema === PARSER_VERSION && Array.isArray(cached.items) ? cached.items : [];
  if (!base.length) return null;

  const byMonth = {};
  base.forEach((it) => {
    byMonth[it.month] = it;
  });

  let added = 0;
  for (let page = 1; page <= 2; page++) {
    const r = await searchPage(SEARCH_QT, page);
    if (!r.docs.length) break;
    for (const d of r.docs) {
      const it = normalizeSearchDoc(d);
      if (!it || byMonth[it.month]) continue;
      byMonth[it.month] = it;
      added++;
    }
    await sleep(200);
  }

  const items = Object.keys(byMonth).map((k) => byMonth[k]);
  items.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  // 没抓到新月份就不动 fetchedAt，否则 6 小时 TTL 会被无限续上
  if (added) {
    writeJson(INDEX_CACHE, {
      schema: PARSER_VERSION,
      fetchedAt: Date.now(),
      exhausted: true,
      items: items,
    });
  }
  return { items: items, added: added };
}

/**
 * 构建“月份 → 文章”索引：优先站内搜索（能回溯到 2011），失败则退回列表页扫描。
 */
async function buildArticleIndex(want) {
  const cached = readJson(INDEX_CACHE);
  const now = Date.now();
  if (
    cached &&
    cached.schema === PARSER_VERSION &&
    Array.isArray(cached.items) &&
    cached.items.length &&
    now - cached.fetchedAt < 6 * 3600 * 1000
  ) {
    return cached.items;
  }

  let items = [];
  try {
    items = await searchArticleIndex();
  } catch (e) {
    console.warn('[nbs70] 站内搜索索引失败，回退到列表页：' + e.message);
  }

  if (items.length < 12) {
    const fallback = await scanListPages(want);
    const seen = {};
    items.forEach((it) => {
      seen[it.url] = true;
    });
    for (const it of fallback) {
      if (seen[it.url]) continue;
      seen[it.url] = true;
      items.push(it);
    }
  }

  items.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  writeJson(INDEX_CACHE, {
    schema: PARSER_VERSION,
    fetchedAt: now,
    exhausted: true,
    items: items,
  });
  return items;
}

// ---------------------------------------------------------------- 文章解析

/** 把 <table> 拆成二维文本数组 */
function parseTableRows(tableHtml) {
  const rows = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRe = /<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRe.exec(rm[0])) !== null) {
      cells.push(cellText(cm[0]));
    }
    rows.push(cells);
  }
  return rows;
}

function toNumber(v) {
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 判断表格类型
 *   2016 年后表头：“70个大中城市新建商品住宅销售价格指数”
 *   2011-2015 年表头：“70个大中城市新建住宅/新建商品住宅/二手住宅价格指数”
 *   两类都可能带“分类”子表（90m2 等），需跳过
 */
function tableKind(text) {
  if (/分类/.test(text)) return null;
  if (/新建商品住宅/.test(text) && /价格指数/.test(text)) return 'new';
  if (/二手住宅/.test(text) && /价格指数/.test(text)) return 'second';
  if (/新建住宅/.test(text) && /价格指数/.test(text)) return 'newAll'; // 含保障房，仅在无商品住宅表时兜底
  return null;
}

/** 指数合理区间（防御表头里的“2018年1月”这类数字被当成指数） */
function plausible(v) {
  return v !== null && v > 50 && v < 300;
}

/**
 * 解析一篇文章，返回
 * { month, title, url, publishedAt, new: {城市: {mom,yoy,ytd|fix}}, second: {...} }
 *
 * 表格为左右两栏结构：城市|环比|同比|第4列 ×2
 *   第4列在 2018 年及以前是“定基指数”（存 fix），之后是“1-N 月平均”（存 ytd）
 *   1 月 / 2 月表没有第4列 → 6 列
 */
function parseArticle(html, meta) {
  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html)) !== null) {
    const before = stripTags(html.slice(Math.max(0, tm.index - 600), tm.index));
    const inner = stripTags(tm[0]).replace(/\s+/g, '');
    // 表格自身的 caption 优先；2011-2013 年的“表N：…”就写在 <table> 里面，
    // 只看表格前文的话会把「表3 二手住宅」误判成上一张表的「表2 新建商品住宅」。
    const innerText = inner.slice(0, 300);
    let kind = tableKind(innerText);
    if (!kind && !/分类/.test(innerText)) kind = tableKind(before.slice(-160));
    if (!kind) continue;
    tables.push({ kind: kind, html: tm[0] });
  }

  const maps = { new: null, second: null, newAll: null };

  for (const t of tables) {
    if (maps[t.kind]) continue; // 同一篇文章里表格会重复出现，取第一次
    const rows = parseTableRows(t.html);
    const headerText = rows
      .slice(0, 4)
      .map(function (r) {
        return r.join('');
      })
      .join('|');
    const fourthIsFix = /定基/.test(headerText);
    const map = {};
    let ok = 0;

    for (const cells of rows) {
      const n = cells.length;
      if (n !== 6 && n !== 8) continue;
      const half = n / 2;
      const blocks = [cells.slice(0, half), cells.slice(half)];
      for (const b of blocks) {
        // 个别城市带脚注星号，如 2012-06 的“北京*”、2011-03 的“北京＊”（全角）
        const city = String(b[0] || '').replace(/[*＊※#＃\s]+$/g, '');
        const mom = toNumber(b[1]);
        const yoy = toNumber(b[2]);
        if (!city || !CITY_NAME_RE.test(city)) continue;
        if (!plausible(mom) || !plausible(yoy)) continue;
        const rec = { mom: mom, yoy: yoy, tier: cityTier(city) };
        const fourth = half === 4 ? toNumber(b[3]) : null;
        if (fourth !== null) {
          if (fourthIsFix) rec.fix = fourth;
          else rec.ytd = fourth;
        }
        map[city] = rec;
        ok++;
      }
    }
    if (ok >= 50) maps[t.kind] = map;
  }

  const newMap = maps['new'] || maps['newAll'] || {};
  const cityCount = Object.keys(newMap).length;
  if (cityCount < 50) {
    throw new Error('解析失败：仅识别到 ' + cityCount + ' 个城市（' + meta.month + '）');
  }

  return {
    month: meta.month,
    title: meta.title,
    url: meta.url,
    publishedAt: meta.publishedAt,
    new: newMap,
    second: maps['second'] || {},
  };
}

// ---------------------------------------------------------------- 缓存与任务

function monthCacheFile(month) {
  return path.join(CACHE_DIR, 'month-' + month + '.json');
}

/** 内存缓存：磁盘上已解析的月份对象，避免每次请求重复读盘 / 反序列化 */
const memCache = {};
let knownMonths = null; // null 表示还没扫过目录

function readMonthCache(month) {
  if (memCache[month]) return memCache[month];
  const wrap = readJson(monthCacheFile(month));
  if (wrap && wrap.pv === PARSER_VERSION && wrap.period && wrap.period.month) {
    memCache[month] = wrap.period;
    return wrap.period;
  }
  return null;
}

function rememberMonth(period) {
  memCache[period.month] = period;
  if (knownMonths && knownMonths.indexOf(period.month) < 0) knownMonths.push(period.month);
}

/**
 * 抓取并解析单月数据（优先读缓存）
 *
 * 三层：解析结果（month-YYYY-MM.json）→ 原文（raw/*.html.gz）→ 网络
 * 解析器改动后递增 PARSER_VERSION 只会作废第一层，重算直接吃本地原文。
 */
async function getMonth(meta, force) {
  if (!force) {
    const cached = readMonthCache(meta.month);
    if (cached) return cached;
  }
  let html = force ? null : readRaw(meta.month);
  if (!html) {
    html = await fetchText(meta.url);
    writeRaw(meta.month, html);
  }
  const period = parseArticle(html, meta);
  writeJson(monthCacheFile(meta.month), { pv: PARSER_VERSION, period: period });
  rememberMonth(period);
  return period;
}

/**
 * 补齐原文缓存：把已知月份里还没存原文的逐一抓回来（只存原文，不重解析）。
 * 一次性操作，做完之后改解析器就能完全离线重算。
 */
async function backfillRaw(opts) {
  const onProgress = (opts && opts.onProgress) || function () {};
  const items = await buildArticleIndex(200);
  const missing = items.filter(function (it) {
    return !fs.existsSync(rawFile(it.month));
  });
  const total = missing.length;
  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < missing.length) {
      const meta = missing[cursor++];
      try {
        const html = await fetchText(meta.url);
        writeRaw(meta.month, html);
      } catch (e) {
        console.warn('[nbs70] 原文补全失败 ' + meta.month + '：' + e.message);
      }
      done++;
      onProgress(done, total);
      await sleep(120);
    }
  }
  const runners = [];
  for (let k = 0; k < 3; k++) runners.push(worker());
  await Promise.all(runners);
  return { total: total, done: done };
}

/** 任务状态：在内存里保存一次采集过程，便于前端轮询进度 */
const job = {
  startedAt: 0,
  running: false,
  phase: null, // 'index' 检索索引 / 'fetch' 抓取月报
  auto: false, // 本次任务是不是“跨月自动检查”（失败不需要吓用户）
  target: 0,
  loaded: 0,
  total: 0,
  error: null,
  current: null,
};

function sortDesc(items) {
  return items.slice().sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}

/** 记录“已完整跑过”的目标月份数，避免缓存不足时被前端轮询反复触发全量抓取 */
const STATE_CACHE = path.join(CACHE_DIR, 'state.json');
const lastCompleted = readJson(STATE_CACHE) || { months: 0, at: 0 };

function markCompleted(months) {
  lastCompleted.months = months;
  lastCompleted.at = Date.now();
  writeJson(STATE_CACHE, lastCompleted);
}

function buildSeries(months, force, headOnly) {
  job.running = true;
  job.error = null;
  job.auto = !force;
  job.phase = 'index';
  job.startedAt = Date.now();
  job.target = months;
  job.loaded = 0;
  job.total = months;
  job.current = null;

  // 已有索引底档时只翻前两页（几秒）；本地没有索引才走完整重建（约 1 分钟）
  const indexPromise = headOnly
    ? refreshIndexHead().then((r) => (r ? r.items : buildArticleIndex(months)))
    : buildArticleIndex(months);

  return indexPromise
    .then((items) => {
      job.phase = 'fetch';
      const picked = items.slice(0, months);
      job.total = picked.length;
      // 小并发抓取：单篇约 1-2MB，串行抓 10 年历史要几分钟
      const CONCURRENCY = 3;
      let cursor = 0;
      function worker() {
        if (cursor >= picked.length) return Promise.resolve();
        const idx = cursor++;
        const meta = picked[idx];
        // 强制刷新时只重抓最近 3 个月（统计局可能修订），其余复用缓存
        const refetch = force && idx < 3;
        // 命中本地解析结果时不必限速，否则 190 个月光等就得 8 秒
        const hitCache = !refetch && fs.existsSync(monthCacheFile(meta.month));
        return getMonth(meta, refetch)
          .then((period) => {
            job.loaded++;
            job.current = meta.month;
            return period;
          })
          .catch((err) => {
            job.loaded++;
            job.current = meta.month;
            // 单月失败不影响整体，留空即可
            console.warn('[nbs70] 跳过 ' + meta.month + '：' + err.message);
            return null;
          })
          .then(() => (hitCache ? null : sleep(120)))
          .then(worker);
      }
      const runners = [];
      for (let k = 0; k < CONCURRENCY; k++) runners.push(worker());
      return Promise.all(runners);
    })
    .then(() => {
      job.running = false;
      job.phase = null;
      job.current = null;
      markCompleted(months);
      // 抓完顺手把数据固化成 data/periods.json，并把月份戳打到当前月份
      saveDataset(cachedPeriods(), { checked: true });
    })
    .catch((err) => {
      job.running = false;
      job.phase = null;
      job.error = err.message;
      markCompleted(months);
      throw err;
    });
}

/** 读取 .cache 下已解析的月份 */
function cachedPeriods() {
  if (!knownMonths) {
    knownMonths = [];
    try {
      fs.readdirSync(CACHE_DIR).forEach((f) => {
        const m = /^month-(\d{4}-\d{2})\.json$/.exec(f);
        if (m) knownMonths.push(m[1]);
      });
    } catch (e) {
      knownMonths = [];
    }
  }
  const out = [];
  for (const month of knownMonths) {
    const data = readMonthCache(month);
    if (data && data.month) out.push(data);
  }
  return sortDesc(out);
}

// ---------------------------------------------------------------- 本地数据集

/**
 * data/periods.json —— 把抓到的月份固化成一个 JSON 随项目走。
 *
 * 统计局数据一个月才更新一次，没必要每次启动都去翻网络：日常启动直接读它，零请求。
 * 需要更新时点页面上的「刷新数据」，走一次增量抓取后会自动覆盖该文件。
 */
let datasetCache = null;

/** 本地时区的年月戳，形如 2026-11 */
function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function readDataset() {
  if (datasetCache) return datasetCache;
  const d = readJson(DATASET_FILE);
  if (!d || !Array.isArray(d.periods) || !d.periods.length) return null;
  datasetCache = d;
  return d;
}

/**
 * @param {Array} periods 升序月份数组
 * @param {{checked:boolean}} opts checked=true 表示“刚刚真的向统计局核对过”，
 *        会把月份戳更新为当前月份
 */
function saveDataset(periods, opts) {
  if (!periods || !periods.length) return null;
  const markChecked = !!(opts && opts.checked);
  const prev = readJson(DATASET_FILE) || {};
  const arr = periods
    .slice()
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const doc = {
    generatedAt: new Date().toISOString().slice(0, 10),
    // 月份戳：最近一次向统计局核对的年月，用于“每月最多自动刷一次”
    checkedMonth: markChecked ? currentMonthKey() : prev.checkedMonth || '',
    checkedAt: markChecked ? new Date().toISOString() : prev.checkedAt || '',
    firstMonth: arr[0].month,
    lastMonth: arr[arr.length - 1].month,
    count: arr.length,
    periods: arr,
  };
  try {
    writeJson(DATASET_FILE, doc);
    datasetCache = doc;
    console.log(
      '[nbs70] 本地数据集已更新：' + doc.count + ' 个月（' + doc.firstMonth + ' ~ ' + doc.lastMonth + '）'
    );
  } catch (e) {
    console.warn('[nbs70] 本地数据集写入失败：' + e.message);
  }
  return doc;
}

function datasetMeta() {
  const d = readDataset();
  if (!d) return null;
  return {
    generatedAt: d.generatedAt,
    checkedMonth: d.checkedMonth || '',
    checkedAt: d.checkedAt || '',
    firstMonth: d.firstMonth,
    lastMonth: d.lastMonth,
    count: d.count,
  };
}

/** 把 .cache 里的全部月份导出成 data/periods.json */
function publishDataset() {
  const doc = saveDataset(cachedPeriods(), { checked: true });
  if (!doc) return null;
  return {
    count: doc.count,
    firstMonth: doc.firstMonth,
    lastMonth: doc.lastMonth,
    checkedMonth: doc.checkedMonth,
  };
}

/** 按升序取最近 months 个月 */
function cachedPeriodsAsc(months) {
  return cachedPeriods()
    .filter((p) => p.month)
    .slice(0, months)
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

let runningPromise = null;
/** 自动检查失败后的冷却时间：避免前端轮询反复触发重试 */
const AUTO_RETRY_GAP = 10 * 60 * 1000;
let lastAutoAttempt = 0;

function startJob(months, force, headOnly) {
  runningPromise = buildSeries(months, force, headOnly).then(
    (v) => {
      runningPromise = null;
      return v;
    },
    (e) => {
      runningPromise = null;
      throw e;
    }
  );
  runningPromise.catch(() => {});
}

/**
 * 对外主入口：返回当前可用的数据快照 + 采集进度
 *
 * 自动刷新规则（数据一个月才更新一次，没必要每次打开都联网）：
 *   data/periods.json 里存一个“月份戳” checkedMonth。
 *   - 戳 == 当前月份：本月已经核对过，直接返回本地数据，完全不联网；
 *   - 戳 != 当前月份（跨月了）：后台静默刷一次，完成后把戳改成当前月份。
 * 页面拿到的是本地数据，刷新在后台跑，不会阻塞首屏；若刷新失败，
 * 10 分钟内不再自动重试，避免每次轮询都去拍统计局。
 *
 * @param {{months:number, force:boolean}} opts
 */
function getSnapshot(opts) {
  const months = Math.max(1, Math.min(200, Number(opts.months) || 200));
  const force = !!opts.force;

  // 1) 本地数据集优先
  const ds = readDataset();
  if (ds) {
    const nowMonth = currentMonthKey();
    const stale = ds.checkedMonth !== nowMonth;
    const canRetry = Date.now() - lastAutoAttempt > AUTO_RETRY_GAP;
    if ((force || stale) && !runningPromise && (force || canRetry)) {
      if (!force) lastAutoAttempt = Date.now();
      console.log(
        '[nbs70] ' + (force ? '手动刷新' : '跨月自动检查（戳 ' + (ds.checkedMonth || '空') + ' → ' + nowMonth + '）')
      );
      startJob(months, force, true);
    }

    const running = job.running;
    // 后台自动检查失败不吓用户，下个周期（10 分钟后或下个月）再试
    const realError = job.error && !job.auto ? job.error : null;
    return {
      status: running ? 'loading' : realError ? 'error' : 'ready',
      phase: running ? job.phase : null,
      loaded: running ? job.loaded : ds.periods.length,
      total: running ? job.total : ds.periods.length,
      current: running ? job.current : null,
      error: realError,
      // 正在进行的是“跨月检查”而不是用户主动刷新，前端文案不一样
      autoCheck: running && !force,
      dataset: datasetMeta(),
      source: SOURCE_INFO,
      // 检查期间继续用数据集里的旧数据，页面不会因为 1.5MB 重新拉取而闪一下
      periods: ds.periods.slice(Math.max(0, ds.periods.length - months)),
    };
  }

  // 2) 没有数据集，或用户点了「刷新数据」→ 走一次增量抓取
  const cached = cachedPeriods();
  const recentlyDone =
    lastCompleted.months >= months && Date.now() - lastCompleted.at < 6 * 3600 * 1000;
  const needFetch = force || (cached.length < months && !recentlyDone);

  if (needFetch && !runningPromise) startJob(months, force, false);

  return {
    status: job.running ? 'loading' : job.error ? 'error' : 'ready',
    phase: job.phase,
    loaded: job.loaded,
    total: job.total,
    current: job.current,
    error: job.error,
    dataset: datasetMeta(),
    source: SOURCE_INFO,
    periods: cachedPeriodsAsc(months),
  };
}

/** 预热：启动时先跑一次，减少首屏等待。返回 Promise，完成后给出快照。 */
function warmup(months) {
  const snapshot = getSnapshot({ months: months, force: false });
  if (!runningPromise) return Promise.resolve(snapshot);
  return runningPromise.then(function () {
    return getSnapshot({ months: months, force: false });
  });
}

module.exports = {
  getSnapshot: getSnapshot,
  warmup: warmup,
  backfillRaw: backfillRaw,
  publishDataset: publishDataset,
  TIER1: TIER1,
  TIER2: TIER2,
  // 导出内部函数便于单独调试
  _internal: {
    fetchText: fetchText,
    postForm: postForm,
    parseArticle: parseArticle,
    extractArticles: extractArticles,
    buildArticleIndex: buildArticleIndex,
    searchArticleIndex: searchArticleIndex,
    scanListPages: scanListPages,
    getMonth: getMonth,
  },
};
