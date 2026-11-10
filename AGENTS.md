# AGENTS.md

**项目**：china-economic-stats-dashboard — 中国经济统计数据看板
**模块**：`housing`（70 个大中城市房价指数）/ `macro`（宏观经济：CPI / PPI / PMI / 社零 / M2）/ `lpr`（房贷利率 LPR）/ `livelihood`（民生：结婚 / 离婚登记、初婚人数、出生率 / 死亡率 / 自然增长率）
**一句话定位**：一个网站、四个模块（房价 / 宏观 / LPR / 民生）；宏观经济数据**首次打开一次拉全并缓存，之后按月增量核对**，不是定时爬虫；LPR 同款模型但序列只有一条，全量单文件缓存；民生是年度库版同款模型（按年增量）。数据一律由服务端代取。

> 本文件只放**各模块共用**的规范。宏观模块专属的规范（指标编码探测、发布日、限流、栏目分段、DBnomics 兕底等）写在 `README.md` 的「宏观经济模块」章节，改动宏观模块前必须一并阅读；LPR 模块专属的规范（中国货币网接口、发布日顺延）写在 `README.md` 的「房贷利率 LPR」章节；民生模块的数据源核实结论（为何不用民政部季度公报）、年度库 rootId 与期别编码写在 `README.md` 的「婚育与人口出生」章节。

## 1. 模块边界

| 位置 | 归属 | 说明 |
|---|---|---|
| `server.js` | 共用 | 统一入口：静态托管 + 路由分发（`/api/nbs70`、`/api/macro/*`、`/api/lpr/*`、`/api/livelihood/*`、`/api/health`） |
| `lib/housing/nbs70.js` | housing | 月报检索、正文表格解析、数据集读写、跨月核对 |
| `lib/macro/**` | macro | `config.js` 读 `config/indicators.json`；`cache/policy.js` 是唯一回源判定；`services/series.js` 编排；`sources/nbs.js` + `sources/dbnomics.js` |
| `lib/lpr/**` | lpr | `config.js` 内联上游与发布日常量；`policy.js` 是唯一回源判定；`source.js` 请求中国货币网；`store.js` 全量单文件缓存（`cache/lpr/lpr.json`） |
| `lib/livelihood/**` | livelihood | `config.js` 读 `config/livelihood.json`；`policy.js` 是唯一回源判定（按年度）；`source.js` 请求国家数据年度库（`code=3`、期别 `YYYYYY`）；`store.js` 年度文件缓存（`cache/livelihood/<id>/<YYYY>.json`） |
| `config/indicators.json` | macro | 宏观栏目 / 指标 / 分段 / 发布日 / 兕底的唯一事实来源 |
| `config/livelihood.json` | livelihood | 民生栏目 / 指标 / 单位 / 历史起点的唯一事实来源 |
| `public/index.html` + `home.css` | 共用 | 模块选择入口 |
| `public/housing/`、`public/macro/`、`public/lpr/`、`public/livelihood/` | 各自 | 每个模块自带 html / css / app.js，互不引用 |
| `public/vendor/echarts.min.js` | 共用 | 所有模块共用一份本地 ECharts，**禁止 CDN** |
| `data/periods.json` | housing | 固化数据集（189 个月），随仓库提交 |
| `.cache/` | 运行时 | `housing` 的解析结果与月报原文、`macro/` 的月缓存、`lpr/` 的全量缓存、`livelihood/` 的年度缓存，可随时删 |

- 新增模块时同样落在 `lib/<module>/` 与 `public/<module>/`，API 用 `/api/<module>/*` 前缀，并在入口页加入口卡片。
- 模块之间**不互相 require**。共用能力要么下沉到各自模块内，要么新增 `lib/shared/`，不要跨模块取私有实现。

## 2. 技术约束

| 项 | 要求 |
|---|---|
| 运行时 | Node >= 20，CommonJS |
| 后端 | 原生 `http`，零 npm 依赖，禁止 node-gyp / 需要编译的包 |
| 前端 | 原生 HTML/CSS/JS + 本地 ECharts，禁止 React/Vue，禁止 CDN，禁止 npm 构建 |
| 存储 | 只用 JSON 文件；缓存目录可删，删后按需重建，不影响功能 |
| 端口 | 默认 5173，读 `process.env.PORT`；`start.bat` 内用 `DASH_PORT`（兼容旧的 `NBS_PORT`）覆盖 |
| 服务入口 | `node server.js`；必须经服务访问，直接打开 html 会因同源策略拿不到接口 |

- 批处理 `.bat`：**UTF-8 无 BOM + CRLF**，首行 `chcp 65001 >nul`，否则中文乱码或 `goto :label` 失效。
- PowerShell `.ps1`：**UTF-8 with BOM**，PowerShell 5.1 会按 GBK 解码无 BOM 文件，中文注释直接 ParserError。
- 静态资源：新增页面必须能通过目录访问（`/housing/`、`/macro/`），页面内资源一律写相对路径（`../vendor/...`）。

## 3. 数据与缓存（通用）

- **缓存优先**：有本地数据就用本地数据，只有在缺数据 / 过了发布日 / 用户手动刷新时才回源。
- **拉取模型**：首次运行（本地没有缓存）一次性把历史拉全写入本地，再渲染；之后每次打开只核对应发布期别是否已落缓存——有新一期就补进去，没发布就直接读缓存，不做全量重拉。民生模块是同一模型的年度版（期别换成「年」）。
- **服务端代取**：统计局站点有 WAF，浏览器直连会 403；所有请求都走 `server.js`。
- **首屏不等上游**：区间里有缓存就先出图，回源放后台，前端只消费服务端给的 `stale` / `refreshing` 字段；首次运行无缓存时才等拉全。
- **落后太多就等补齐**：某指标最新缓存月落后应发布期别 3 期以上（如包放半年才打开）时同步补齐再渲染，不先摆过期图；这与上方「不等上游」并不矛盾——后台补数只用于当期缺口。
- **失败回退缓存**：上游失败或返回非 JSON → 回退本地数据并标 `stale: true`，**不抛 500、不返回空数组**。
- **错误码**：客户端传了不存在的指标/路径 → 404（错误对象带 `status`）；只有配置/代码错误才 500。
- **缺失就是缺失**：缺值用 `null`，**不插值、不补 0、不自行加权合成**；一条序列只来自单一数据源。
- **口径必须标注**：同比 / 环比 / 定基是三种口径，不混画同一条曲线；指数 `102.5` 存原始值、展示为 `+2.5%`，图注写「100 = 持平」。
- **不编造**：指标编码、数据、发布日期一律有据可查，禁止猜编码、禁止占位假数据。

## 4. 前端约定

- 配色遵循国内习惯：**红涨绿跌**；所有模块共用同一套视觉变量（`--up`、`--down`、`--accent` 等），新页面沿用。
- 图表单行通栏优先，不做两列并排（数据密度高，并排会压扁坐标轴）。
- 用户可调的筛选条件存 `localStorage` 时，**改默认值必须同时升级键名**（例如 `nbs70.range.v2` → `v3`），否则老用户浏览器里的旧值会静默覆盖新默认值。
- 所有请求走相对根路径的 `/api/...`；不要在前端硬编码端口或 `127.0.0.1`。

## 5. Git 与发布

- 只提交源码：`.gitignore` 覆盖 `node_modules/`、`.cache/`、`release/`；打包脚本（`build.bat` + `packaging/build.ps1`）不含本机路径，随仓库提交。
- `data/periods.json` 与 `config/indicators.json`、`config/livelihood.json` 属于数据/配置资产，**随代码提交**。
- 打包：双击根目录 `build.bat`（或 `powershell -File packaging\build.ps1`）产出 `release/中国经济统计数据看板/` 与 `release/china-economic-stats-dashboard-v<版本>-<系统标签>.zip`；zip 名必须纯 ASCII（中文附件名会被 GitHub 静默丢弃），目录名用中文。
- 分发包必须带 `.cache/macro/`（宏观历史缓存，约 0.2 MB）并且**剔除其中的 `_meta.json`**：带上缓存后对方首次打开只补最近几期；而 `_meta.json` 是本机回源时间戳（10 分钟冷却），进包会抑制对方首次核对。`.cache/lpr/` 与 `.cache/livelihood/` 同理（都随包带、都剔 `_meta.json`）。
- 批处理负责搬运、PowerShell 负责逻辑：`.bat` 里不写大段中文（长批处理含多字节字符时 cmd 可能错行，把半行注释当命令执行），实现放在 UTF-8 with BOM 的 `.ps1` 里。
- 发布走 GitHub Release + Tag `vX.Y.Z`，版本号以 `package.json` 为准。
- 公开仓库：仓库级 git 身份为 `cwq503448212` + GitHub noreply 邮箱；提交前确认不含公司邮箱/真名拼音。
- README 必写：两种用法（源码版 / 一键包版）、数据来源与稳定性声明、缓存目录说明。

## 6. 禁止

- 把统计局站点内部接口说成官方开放 API
- 回退到已被 WAF 拦截的 EasyQuery 路由
- 高频轮询、遍历指标树「预热」、绕过限流 / 验证码
- 前端直连统计局域名
- 编造编码 / 编造数据 / 插值补齐 / 缺失画成 0
- 提交 exe、缓存目录、打包产物
- 改动宏观模块却不看 `README.md` 的「宏观经济模块」章节
