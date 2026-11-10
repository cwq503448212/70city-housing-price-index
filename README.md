# 中国经济统计数据看板

一个零依赖的本地看板，把国家统计局的两类月度数据放在同一个服务里：

| 模块 | 地址 | 内容 |
| --- | --- | --- |
| **70 个大中城市房价指数** | `/housing/` | 新房 / 二手住宅环比、同比，城市排行、涨跌城市数、热力图、定基指数 |
| **宏观经济指标** | `/macro/` | CPI / 核心 CPI / PPI / 八大类 / PMI / 社零 / M1·M2 |

打开根地址 `/` 是模块选择页，点进去分别进入两个子页面；每个子页面右上角都有「← 模块选择」可以切回来。

![模块选择入口](docs/screenshot-home.png)

## 快速开始

**Windows：直接双击 `start.bat`** —— 会自动启动服务并打开浏览器；如果服务已在运行，则只打开页面。关闭窗口即停止服务。

命令行等价写法：

```bash
node server.js
```

然后打开 <http://127.0.0.1:5173>。

> 必须通过这个本地服务访问，直接双击 `public/**/index.html` 是不行的：`file://` 下 `fetch('/api/...')` 会被浏览器拦下，拿不到数据；而且统计局站点有 WAF，浏览器直连会 403，数据只能由服务端代取。

- 需要 Node >= 20，**不需要 `npm install`**（ECharts 已内置在 `public/vendor/`，两个模块共用一份）。
- 两个模块共用同一个端口和同一个进程，`/api/health` 会一并返回两边的概况。
- 换端口：`PORT=8080 node server.js`（PowerShell 写法 `$env:PORT=8080; node server.js`）。用 `start.bat` 时可以 `set DASH_PORT=5180` 后再双击（旧的 `NBS_PORT` 仍然兼容）。

## 目录结构

```
server.js                    本地 HTTP 服务：静态托管 + 路由分发（/api/nbs70、/api/macro/*）
start.bat                    Windows 一键启动（双击即可）
build.bat                    便携包一键打包（双击；转发给 packaging/build.ps1）
AGENTS.md                    两个模块共用的开发规范

lib/housing/nbs70.js         房价：站内搜索建索引 → 月报正文表格解析 → 数据集/缓存读写
lib/macro/config.js          宏观：装载并校验 config/indicators.json
lib/macro/api.js             宏观：range / from-to / force 参数解析
lib/macro/services/series.js 宏观：缓存优先、按栏目批量取数、分段拼接、DBnomics 兜底
lib/macro/cache/policy.js    宏观：该不该回源的唯一判定
lib/macro/cache/store.js     宏观：JSON 月缓存读写（.cache/macro/<指标id>/<YYYY-MM>.json）
lib/macro/sources/nbs.js     宏观主源：国家数据新版站点接口
lib/macro/sources/dbnomics.js 宏观兜底：DBnomics 开放 API
lib/macro/util/              极简 HTTP 客户端 / 串行限流 / 月份工具

config/indicators.json       宏观指标配置（栏目 / 指标 / 分段 / 发布日 / 兜底）
probe.js                     宏观指标编码探测 + 官方/镜像交叉校验

public/index.html            模块选择入口（+ home.css）
public/housing/              房价看板：index.html / styles.css / app.js
public/macro/                宏观看板：index.html / styles.css / app.js
public/vendor/               ECharts 5（两个模块共用）

data/periods.json            房价数据集（189 个月，随项目分发）
docs/                        页面截图
packaging/                   便携包的 start.bat / 使用说明.txt / build.ps1（打包实现）
release/                     打包产物，不入库
.cache/                      抓取中间产物：房价解析结果与月报原文、macro/ 宏观月缓存（可安全删除）
```

---

# 模块一：70 个大中城市房价指数

## 数据来源

| 项目 | 说明 |
| --- | --- |
| 原始出处 | 国家统计局 · 数据发布《XX 年 X 月份 70 个大中城市商品住宅销售价格变动情况》 |
| 页面地址 | <https://www.stats.gov.cn/sj/zxfb/> |
| 更新频率 | 每月中旬发布上月数据 |
| 可回溯区间 | **2011 年 1 月起**，共 189 个月（70 城数据自 2011-01 开始按月发布，更早的月度分城市数据官方未公开） |
| 本地数据集 | `data/periods.json`（1.4 MB / 189 个月），随项目分发，启动时直接读它 |
| 指标口径 | 指数以「上月 = 100」「上年同月 = 100」为基准，页面统一换算成涨跌幅（指数 − 100） |

![70 城房价看板](docs/screenshot-overview.png)

### 历史月报是怎么找回来的

「数据发布」列表页（`/sj/zxfb/`）只静态生成到 `index_66.html`，最深只能翻到 2021 年 11 月，看不到更早的月报。而 2011–2022 年的文章其实都还在，只是被批量迁移进了 `/sj/zxfb/202302/`、`/sj/zxfb/202303/` 这类归档目录，列表页里不再有入口。

所以索引改走 **统计局站内搜索**：`POST https://api.so-gov.cn/query/s`，表单体 `{ siteCode: 'bm36000002', qt: '70个大中城市商品住宅销售价格变动情况', page, pageSize }`（`siteCode` 取自页面 `<meta name="SiteIDCode">`）。搜索能命中 2011 年以来的全部月报，再对命中结果按年月去重，对少数漏搜的月份做精确补搜。列表页扫描保留为兜底分支。

索引结果缓存 6 小时，见 `.cache/index.json`。

### 数据一次性固化在本项目里

统计局一个月才更新一次，没必要每次打开都去翻网络。抓到的全部月份会被固化成 **`data/periods.json`**（189 个月，约 1.4 MB）：

- 启动时直接读它，**零网络请求**，打开即用；
- 顶部的时间范围只影响展示，同样不触发下载；
- 需要更新数据时才点右上角「刷新数据」—— 会重新检索引（前两页，几秒）、只抓缺失的月份，完成后自动覆盖 `data/periods.json`。

`.cache/` 是抓取过程中的中间产物（解析结果 + 月报原文），可以随时删；`data/` 是成果，建议一起提交到仓库。

### 月份戳：每月最多自动核对一次

`data/periods.json` 里有两个字段记录「上次什么时候核对的」：

```json
{
  "checkedMonth": "2026-11",
  "checkedAt": "2026-11-09T13:05:19.380Z"
}
```

打开页面（或服务启动）时的规则：

| 月份戳 | 行为 |
| --- | --- |
| `checkedMonth` == 当前月份 | 本月已核对过，直接用本地数据，**不联网** |
| `checkedMonth` != 当前月份（跨月了） | 后台静默核对一次，完成后把戳改成当前月份 |

核对只翻搜索结果的前两页（新发布的月报一定在最前面），抓到新月份才去下载该月原文，所以通常**一两秒**就完。整个过程在后台跑，页面先用旧数据渲染，不会卡在加载页；核对失败也不弹错，10 分钟后或下个月再试。

### 接口

`GET /api/nbs70?months=24&force=0`

`months` 取值 1–200（200 = 全部历史）。默认走本地数据集；只有当月份戳不是当前月时，才会在后台做一次静默核对。带 `force=1` 立即核对并重抓最近 3 个月。

```jsonc
{
  "status": "ready",        // loading | ready | error
  "phase": null,            // index（正在建历史索引）| fetch（正在抓月报）
  "loaded": 22,             // 已解析月份数（loading 时用于进度条）
  "total": 24,
  "dataset": {              // 数据来源：本地数据集存在时体现在这里
    "generatedAt": "2026-11-09",
    "checkedMonth": "2026-11",   // 月份戳：上次向统计局核对的年月
    "checkedAt": "2026-11-09T13:05:19.380Z",
    "firstMonth": "2011-01",
    "lastMonth": "2026-09",
    "count": 189
  },
  "autoCheck": false,       // true = 后台正在做“跨月自动核对”，前端文案不同
  "periods": [              // 按月份升序
    {
      "month": "2026-09",
      "publishedAt": "2026-10-19",
      "title": "2026年9月份70个大中城市商品住宅销售价格变动情况",
      "url": "https://www.stats.gov.cn/...",
      "new": {              // 新建商品住宅
        "北京": { "mom": 99.8, "yoy": 97.3, "ytd": 97.7, "tier": 1 }
      },
      "second": { /* 二手住宅，结构同上 */ }
    }
  ]
}
```

- `mom` 环比、`yoy` 同比，均为指数值（100 = 持平）。
- 第 4 列的口径年年在变：**2018 年及以前**统计局给的是「定基指数」（以 2010 年或上轮基期为 100），存在 `fix` 字段；**2019 年起**改成「1—N 月平均」，存在 `ytd` 字段。两者不可直接比较，前端未使用。
- `tier`：1 一线 / 2 二线 / 3 三线，按国家统计局 70 城分类口径。

## 图表说明

| 模块 | 内容 |
| --- | --- |
| KPI 卡片 | 最新月份、新房 / 二手的环比上涨城市数、同比下跌城市数 |
| 指数走势 | 多城市对比折线，城市可自由勾选，支持按档位一键选全 |
| 涨跌城市数 | 每月 70 城中上涨 / 持平 / 下跌的堆积柱 |
| 城市排行 | 最新月份 70 城横截面排序，红涨绿跌，右侧滑块可滚动 |
| 城市 × 月份热力图 | 70 城 × N 月的涨跌幅矩阵，默认从一线城市开始（列数上限 60，取最近 60 个月） |
| 单城详情 | 选定城市新房 vs 二手房的走势对比 |
| 定基指数走势 | 自选起点/终点月份，以起点月为 100，按环比逐月累乘，对比新房与二手房的区间累计涨跌 |
| 明细数据 | 最新月份全量数据表，点表头排序、点行切换单城详情 |

所有图表都是**单行通栏**，不并排：数据密度高，两列并排会把坐标轴和柱子压得太细。

顶部两个开关（房屋类型 / 对比口径）会同步作用于除 KPI 和定基指数外的所有图表。

顶栏的**时间范围**是全局过滤器：它不删数据，只是把展示窗口从 189 个月里切出一段（`state.view`），走势、城市数、排行、热力图、单城详情、明细表全部跟着变；定基指数那块有自己独立的起止月份下拉（默认跟随当前区间），标注了「不受上方开关影响」。默认「近 5 年」，选择记在 `localStorage`（键 `nbs70.range.v2`）里。

### 定基指数的算法

```
index[起点] = 100
index[t]  = index[t-1] × 环比指数[t] / 100
```

注意起点月份自身的环比**不参与**计算（它已经定义为 100），区间涨跌 = `index[终点] − 100`。
例如北京新房 2025-10 → 2026-09 累乘得到 97.62，即区间下跌 2.4%。

![定基指数走势](docs/screenshot-base-index.png)

## 解析兼容性

- 单月解析失败不会影响整体，会跳过该月并在日志里提示；如需重试，加 `?force=1` 或删掉 `.cache/`。
- `.cache/raw/` 存放月报原文（gzip 压缩，189 篇共约 8 MB）。解析器改了之后，有原文的月份可以离线重解析，不必重新下载；需要全量回填原文时 `npm run data:raw`。
- 解析要兼容三代表结构：2011–2016 的表头写作「新建住宅价格指数 / 二手住宅价格指数」（无「销售」二字），2016–2022 为「商品住宅」，2023 起回归「商品住宅销售价格」；此外 2012-06 北京的城市名带脚注星号「北京*」，均已做兼容。
- 若统计局改版导致解析失败，主要调整 `lib/housing/nbs70.js` 里的 `buildArticleIndex` / `searchArticleIndex`（索引）、`tableKind`（表类型识别）与 `parseArticle`（正文表格）。解析器改动后请递增 `PARSER_VERSION`，旧缓存会自动失效。
- 页面配色遵循国内习惯：**红涨绿跌**。

---

# 模块二：宏观经济指标

国家统计局月度宏观数据的本地看板：**CPI / 核心 CPI / PPI / 八大类 / PMI / 社零 / M1·M2**，共 20 个指标。
顶部一个时间范围下拉框，切换后 KPI、全部图表、明细表一起变。

## 看板上有什么

| 区块 | 内容 | 口径 |
| --- | --- | --- |
| KPI 卡片 | CPI 同比、核心 CPI 同比、PPI 同比、制造业 PMI、社零同比、M2 同比 | 涨跌幅 / 扩散指数 |
| 通胀走势 | CPI、核心 CPI、PPI 三条同比线 | 上年同月 = 100 |
| CPI 环比 | 单月环比柱状图（红涨绿跌） | 上月 = 100 |
| 制造业 PMI | 走势 + 50 荣枯线 | 扩散指数，50 = 荣枯线 |
| 消费与货币 | 社零同比 vs M2 同比 | % |
| CPI 八大类 | 所选区间**末月**八类同比横向条形，按涨幅排序 | 上年同月 = 100 |
| 指标明细 | 20 个指标的最新值 / 上期 / 变化 / 期别 / 来源 / 状态 | — |

时间范围支持 **近 1 年 / 3 年 / 5 年 / 10 年 / 全部 / 自定义起止月**，默认近 5 年，切换后整页联动。

![宏观经济指标看板](docs/screenshot-macro.png)

## 数据源

**主源：国家统计局「国家数据」新版站点内部接口**

```
GET  https://data.stats.gov.cn/dg/website/publicrelease/web/external/new/queryIndexTreeAsync?pid=&code=1
GET  …/new/queryIndicatorsByCid?cid=<栏目id>&dt=&name=
POST …/stream/esData      （取数，一个栏目一次可带多个指标，支持任意月份区间）
```

取数 body 必须带 `rootId`（月度数据 `fc982599aa684be7969d7b90b1bd0e84`）、`das: [{text:'全国', value:'000000000000'}]`、`dts: ['202101MM-202612MM']`（可一次取任意区间）；响应里 `data[].code` 是期别（`202609MM`），`values[]._id` 是指标 id，`values[].da` 是地区码（只收 `000000000000`）。

> ⚠️ **稳定性声明**：这是统计局网站前端自己用的内部接口，**不是官方开放 API**，也没有任何稳定性承诺。
> 老版 EasyQuery（`easyquery.htm?m=QueryData`）已被站点 WAF 全站拦截（403 / `reason:UrlACL`，浏览器直连同样拦），不要再回退到那条路由；接口一旦变化，需要重新用 `probe.js` 探测编码。

**兜底：DBnomics 开放 API**（`api.db.nomics.world/v22/series/NBS/<dataset>/<series>`），只在主源失败时使用。它镜像的 NBS 月度序列**只保留最近 13 期**且滞后，所以兜底数据一定标 `stale`，页面显示「待更新」。

## 指标编码不靠猜

`config/indicators.json` 里每个栏目 id、指标 id 都是用工具探测出来的，并且和 DBnomics 同期刊做过交叉校验（容差 0.1）：

```powershell
node probe.js tree                                   # 列出「月度数据」栏目树
node probe.js tree <父栏目id>                         # 展开子栏目
node probe.js indicators <栏目id>                     # 栏目下指标清单（id / 名称 / 起止）
node probe.js data <栏目id> <指标id> 2026-08 2026-10   # 实际取数看口径
node probe.js check                                  # 全部指标：官方 vs DBnomics 交叉校验
```

改指标的流程：`tree` → `indicators` → `data` 看量级 → 写进配置 → `check` 通过。也可以 `npm run probe`。

统计局把 CPI/PPI 分类指数**按年份拆成多个栏目**（`2026-`、`2021-2025`、`2016-2020`、`-2015`），所以一个指标可能需要多个 `segments` 拼接；历史起点定在 `2021-01`（现行八大类口径）。另外 2026 年起统计局把「食品烟酒类」调整为「食品烟酒及在外餐饮类」，配置里已做分段，页面会标注这个口径变化。

## 缓存与拉取策略

- 缓存键 = **指标 id + 统计月份**，落盘 `.cache/macro/<指标id>/<YYYY-MM>.json`，内容 `{ id, month, raw, source, fetchedAt }`
- `raw` 存**原始值**（指数存 101.3，不存 1.3），换算成涨跌幅在接口/前端做，改口径不用重拉
- **首次打开：一次拉全**。本地一个月的缓存都没有时（首次运行，或者删了 `.cache/macro/`），打开页面会把每个指标从 `2021-01` 到应发布期别**整段拉全**并写入缓存（约 8 次请求、半分钟左右），不按当前展示区间“缺多少拉多少”。便携分发包自带一份 `.cache/macro/`，因此拿到包的人不会遇到这个半分钟
- **之后每次打开：只核对当月缺口**。有缓存的指标直接用缓存出图；只有当「应发布期别还没落到缓存」时，才去后台问一次统计局——有新一期就补进去，没发布就继续用缓存
- **缓存落后得多时会等补齐再出图**：某指标最新缓存月比应发布期别落后 3 期以上（比如包放了半年才打开），这次打开就同步补齐，不把明显过期的图先摆出来
- 只有三种情况会向统计局发请求：
  1. 该统计月没有缓存（首次运行，或缓存被删）；
  2. 已过该指标发布日，而缓存期别仍早于应发布期别；
  3. 用户点「刷新数据」。
- 判定逻辑集中在 `lib/macro/cache/policy.js`，**前端只消费 `stale` 字段，不自己算月份**
- 发布日规则写在配置里：CPI / PPI = 每月 9 日发上月，社零 / M2 = 每月 15 日，PMI = 当月月末；本身不发布的月份用 `exemptMonths` 排除（社零 1、2 月合并公布），不计入「缺数据」
- **首屏不等上游**：区间里有缓存就直接出图（先标 `stale`），「确认要不要更新」放到后台跑，响应里的 `refreshing > 0` 表示后台正在补，前端会在 3 秒后自己再取一次，最多补 10 次（约 30 秒）；首次运行没有缓存、或缓存落后 3 期以上，才会等补齐再渲染
- 限流三层，缺一不可：所有对外请求串行（同一时刻只 1 个）+ 全局最小请求间隔（统计局 1200 ms、DBnomics 500 ms）+ 同一指标 60 秒冷却（冷却期内直接跳过，不排队）
- 两次回源尝试至少间隔 10 分钟（记在 `.cache/macro/<id>/_meta.json` 的 `lastAttempt`，**落盘**，进程重启后仍生效，避免每次冷启动都把「上游还没更新」的指标重拉一遍）
- 上游失败或返回非 JSON → **回退缓存并标 `stale: true`**，不抛 500、不返回空数组；客户端传了不存在的指标 id → 404

缓存目录默认是项目下的 `.cache/macro/`，可用环境变量指到任意可写目录（打包分发时用）：

```powershell
set MACRO_DATA_DIR=D:\macro-cache
```

删掉 `.cache/macro/` 不会丢配置，只是下次打开会重新拉全（约 8 次请求、半分钟左右）。

## 口径规则（不许破）

- 同比、环比、定基指数是三种指标，**不混画同一条曲线**，图上标题必须标明
- 指数 `102.5` 存原始值，展示为 `+2.5%`，图注写「100 = 持平」
- 缺失用 `null`，不插值、不补 0；社零 1、2 月合并公布，配置里用 `exemptMonths` 标出，不算「缺数据」
- 分项**不自行加权合成**总指数
- 一条序列只来自单一数据源，不混排

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查（两个模块共用，含房价数据集与宏观缓存概况） |
| `GET /api/macro/health` | 同上，宏观模块内的别名 |
| `GET /api/macro/indicators` | 指标清单（不含数据，含 stale / latestCached） |
| `GET /api/macro/overview` | 看板一次性取全量（顶部时间选择就靠它；含 `refreshing` 后台补齐标记） |
| `GET /api/macro/series/:id` | 单指标序列 |
| `GET /api/macro/refresh/:id` | 手动刷新单指标（等价于 `series?id&force=1`） |

查询参数：`range=12|36|60|120|all`、`from=YYYY-MM&to=YYYY-MM`（优先于 range）、`force=1`。

---

## 打包给别人（对方不装 Node）

`node server.js` 需要 Node 运行时。要发给装不了 Node 的人，用**便携包**：把 `node.exe` 和项目一起打进去，对方解压双击 `start.bat` 就行，**不需要安装任何东西**。

出包有两种方式，产物一致：

- **双击根目录的 `build.bat`**（推荐，窗口里会显示进度，跑完停住等你看结果）；
- 或者在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1
```

`build.bat` 只负责转发，真正干活的是 `packaging/build.ps1`；`build.bat` 故意写成纯 ASCII，避免 cmd 解析长批处理里的多字节字符时错行。

产物：

```
release/中国经济统计数据看板/                                      解压后双击 start.bat
release/china-economic-stats-dashboard-v2.0.0-win10-win11.zip     对外发送
```

包内是 `node.exe`（官方签名二进制，v20.12.2）、`server.js`、`lib/`、`config/`、`public/`、`data/periods.json`、`probe.js`、`docs/`、`README.md`、`start.bat`、`使用说明.txt`，以及一份 `.cache/macro/`；不含 `node_modules/`、`AGENTS.md`。功能与源码版完全一致：两个模块、跨月自动核对、「刷新数据」都照常可用。

- **分发包默认带宏观历史数据**：`.cache/macro/` 里是 20 个指标、约 1200 个月度文件（0.2 MB，打包时自动剔除本机的 `_meta.json` 回源时间戳），对方首次打开只需补最近几期，几秒钟就全了；删掉它才会全量重拉。
- **包放很久才打开也没问题**：缓存里有多少就用多少，缺的月份按「应发布期别」一次性补齐（缺 3 个月就只拉 3 个月，不会从头重拉）。只有统计局改了栏目/接口时才需要重新发版，否则最多看到「待更新」提示。

- 便携版的 `start.bat` 和 `使用说明.txt` 放在 `packaging/` 里跟代码一起维护，打包时会拷过去。
- 想换 node.exe：`set NODE_EXE=D:\soft\nvm\v20.12.2\node.exe` 后再跑，或 `packaging\build.ps1 -NodeExe '…\node.exe'`（脚本带版本守卫，低于 Node 20 直接报错）。
- 内置的是 Node 20，因此**只支持 Windows 10 / 11**；Windows 7 / 8 不再支持（Node 18 起已放弃这些系统，最后能跑 Win7 的是 Node 16）。
- `release/` 已加进 `.gitignore`，几十 MB 的 `node.exe` 不进仓库；打包脚本本身不带本机路径，随仓库一起提交。
- zip 直接用纯 ASCII 名（`china-economic-stats-dashboard-v<版本>-<系统>.zip`），因为 GitHub Release 附件名不接受中文、会被静默删掉；zip 内部顶层目录仍是中文的 `中国经济统计数据看板`。
- 换支持的 Windows 范围时改系统标签（默认 `win10-win11`）：双击时用 `build.bat win7-win11`，命令行用 `build.ps1 -SysTag 'win7-win11'`。

> 为什么不用 pkg 打成单个 exe：体积差不多（~45 MB），但自解压 exe 常被杀软误报；更麻烦的是包内 `data/` 会变成只读的虚拟文件系统，「刷新数据」写不进去，得额外改路径。便携 `node.exe` 是官方签名的，零误报、行为完全一致。

## 备注

- **房价不是成交均价**。价格指数反映的是价格变动的相对幅度，不含绝对价格水平。
- 宏观接口随时可能变化或限流，页面出现「待更新」属正常现象，请以统计局官网公布为准。
- 两个模块的数据版权均归国家统计局所有，本项目只做本地可视化，不保存、不分发原始数据库。
- 仅供数据观察，**不要用于任何投资决策依据**。

## 反馈与联系

- **问题 / 建议**：优先到 [Issues](https://github.com/cwq503448212/china-economic-stats-dashboard/issues) 提，便于追踪与公开讨论
- **邮箱**：503448212@qq.com（仅用于本项目相关沟通）
