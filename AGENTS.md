# AGENTS.md

**项目**：china-economic-stats-dashboard — 中国经济统计数据看板
**模块**：`housing`（70 个大中城市房价指数）/ `macro`（宏观经济：CPI / PPI / PMI / 社零 / M2）/ `lpr`（房贷利率 LPR）/ `livelihood`（民生 · 人口与婚育：人口年龄结构与抚养比、老龄化、平均预期寿命、结婚 / 离婚登记、初婚人数、出生率 / 死亡率 / 自然增长率、出生 / 死亡人口与自然增长量 / 生死比〔后四者为计算值〕）/ `livelihood-income`（人均收入与支出）/ `livelihood-deposit`（居民存款与人均存款）/ `livelihood-retail`（社会消费品零售）/ `livelihood-employment`（就业：城镇调查失业率、周平均工时、农民工、城镇登记失业）/ `livelihood-security`（养老医保：五险基金收支结余、职工与城乡居民养老、基本医保、失业工伤生育、人均养老金支出 / 可支付月数 / 参保率）/ `industry`（工业行业运行：41 个大类行业增加值当月同比、营业收入与利润总额累计同比，制造业与非制造业 PMI 分项）
**一句话定位**：一个网站、十个看板（房价 / 宏观 / LPR / 人口与婚育 / 收支 / 存款 / 社零 / 就业 / 养老医保 / 行业运行）；宏观经济数据**首次打开一次拉全并缓存，之后按月增量核对**，不是定时爬虫；LPR 同款模型但序列只有一条，全量单文件缓存；人口与婚育、收支都是年度库版同款模型（按年增量），共用同一年度库与限流，但配置、缓存目录、路由各自独立；人口模块的年龄结构 / 抚养比 / 预期寿命与婚姻 / 人口千分率同属一个页面，带 `until` 的预期寿命归档不回源；存款走央行信贷收支表 htm 附件（按年文件缓存、按月核对）；社零是国家数据月度库版同款模型（按栏目分文件、按月核对，扣掉 1、2 月合并公布）；就业是**月度库 + 年度库双频次**模型（同一个栏目文件里按 `YYYY-MM` 与 `YYYY` 两种期别落盘，月度按月核对、年度按栏目 `releaseMonth` 核对，带 `until` 的停更序列归档不回源）。养老医保是年度库同款模型（九个栏目、按栏目分文件、按年核对，基金收支结余 / 参保 / 待遇人数全为原值，当期结余、人均养老金、可支付月数、参保率为现算，生育基金 2018 与生育待遇人数 2021 按 `until` 归档）。行业运行是国家数据月度库版同款模型（五个栏目、按栏目分文件、按月核对；增加值 1、2 月合并公布、营收利润 1 月不发布、PMI 当月月末发布，所以区间右端点取四个应发布月份里最晚的那个；整页 `stale` 只看栏目层面，累计同比基数为负时统计局本来就不发布，属上游真实缺值）。数据一律由服务端代取。

> 本文件只放**各模块共用**的规范。宏观模块专属的规范（指标编码探测、发布日、限流、栏目分段、DBnomics 兜底等）写在 `README.md` 的「宏观经济模块」章节，改动宏观模块前必须一并阅读；LPR 模块专属的规范（中国货币网接口、发布日顺延）写在 `README.md` 的「房贷利率 LPR」章节；民生模块的数据源核实结论（为何不用民政部季度公报）、人口结构与预期寿命的口径（年末口径、抚养比取官方值、65 岁以上占比为计算值、`until` 归档、出生 / 死亡人口由千分率还原为计算值）、年度库 rootId 与期别编码写在 `README.md` 的「人口与婚育」章节；人均收支的口径铁律（只有名义增速、分项不合成、城乡不平均）写在 `README.md` 的「人均收入与支出」章节（23 个指标编码见 `config/income.json`）；存款模块的数据源核实结论（为何不用新闻稿 / 国家数据）、htm 表格解析与「新增、同比、人均全是计算值」的口径铁律写在 `README.md` 的「居民存款与人均存款」章节；社零模块的 1、2 月合并公布、网上零售 2026 换口径、剔除汽车与限额以上品类的计算口径写在 `README.md` 的「社会消费品零售」章节（栏目 / 指标编码见 `config/retail.json`）；就业模块为何不展示「城镇新增就业」、调查失业率与登记失业率的区别、16—24 岁口径变更与 `until` 归档规则写在 `README.md` 的「就业」章节（栏目 / 指标编码见 `config/employment.json`）；养老医保模块为何不解析人社部 / 医保局公报、当期收支与累计结余的区别、医保参保 2017 口径断点、参保率分母选择与 `until` 归档规则写在 `README.md` 的「养老医保」章节（栏目 / 指标编码见 `config/security.json`）；行业运行模块为何不叫「行业景气度」、四口径（增加值当月同比 / 营收利润累计同比 / PMI 扩散指数）不混画与不做单月差分、上游空档与 `stale` 只看栏目层面的规则写在 `README.md` 的「工业行业运行」章节（栏目 / 指标编码见 `config/industry.json`）。以上七个子模块的章节，改动前必须一并阅读。

## 1. 模块边界

| 位置 | 归属 | 说明 |
|---|---|---|
| `server.js` | 共用 | 统一入口：静态托管 + 路由分发（`/api/nbs70`、`/api/macro/*`、`/api/lpr/*`、`/api/livelihood/*`、`/api/livelihood/income-expenditure`、`/api/livelihood/reserve-deposit`、`/api/livelihood/retail`、`/api/livelihood/employment`、`/api/livelihood/security`、`/api/industry/*`、`/api/health`） |
| `lib/housing/nbs70.js` | housing | 月报检索、正文表格解析、数据集读写、跨月核对 |
| `lib/macro/**` | macro | `config.js` 读 `config/indicators.json`；`cache/policy.js` 是唯一回源判定；`services/series.js` 编排；`sources/nbs.js` + `sources/dbnomics.js` |
| `lib/lpr/**` | lpr | `config.js` 内联上游与发布日常量；`policy.js` 是唯一回源判定；`source.js` 请求中国货币网；`store.js` 全量单文件缓存（`cache/lpr/lpr.json`） |
| `lib/livelihood/**` | livelihood | `config.js` 读 `config/livelihood.json`；`policy.js` 是唯一回源判定（按年度，含 `until` 归档）；`source.js` 请求国家数据年度库（`code=3`、期别如 `2024YY`）；`store.js` 年度文件缓存（`cache/livelihood/<id>/<YYYY>.json`；「最新有效年份之前」的空洞落 `raw: null` 占位避免反复回源，「最新值之后」的缺口不落，保留「待更新」）；`service.js` 现算 4 个计算量（`rate_count` 出生 / 死亡人口、`diff` 自然增长量、`ratio` 生死比），不落盘、不参与回源 |
| `lib/livelihood/income/**` | livelihood-income | `config.js` 读 `config/income.json`；`store.js` 独立缓存目录（`cache/livelihood-income/<id>/<YYYY>.json`）；`service.js` / `api.js` 编排；取数复用父目录的 `source` / `queue` / `policy` |
| `lib/livelihood/deposit/**` | livelihood-deposit | `config.js` 读 `config/deposit.json`；`source.js` 请求央行栏目页 → 年份页 → 信贷收支表 htm 附件并解析；`store.js` 年度文件缓存（`cache/livelihood-deposit/years/<YYYY>.json` + 人口分母）；`policy.js` 发布月份与回源判定；`service.js` / `api.js` 编排；限流复用父目录的 `queue` |
| `lib/livelihood/retail/**` | livelihood-retail | `config.js` 读 `config/retail.json`；`policy.js` 是唯一回源判定（含 1、2 月合并公布与发布日回退）；`source.js` 请求国家数据月度库（`code=1`、期别如 `2026-09`）；`store.js` 按栏目分文件（`cache/livelihood-retail/catalogs/<key>.json`）；`service.js` 现算 4 个计算口径；限流复用父目录的 `queue` |
| `lib/livelihood/employment/**` | livelihood-employment | `config.js` 读 `config/employment.json`；`policy.js` 是唯一回源判定（月度 15 日规则 + 年度 `releaseMonth` + `until` 归档）；`source.js` 同时支持月度库（`code=1`、`YYYYMM`）与年度库（`code=3`、`YYYY`）；`store.js` 按栏目分文件（`cache/livelihood-employment/catalogs/<key>.json`，同文件存月度与年度期别）；`service.js` 现算 3 个计算口径；限流复用父目录的 `queue` |
| `lib/livelihood/security/**` | livelihood-security | `config.js` 读 `config/security.json`（校验四种 `derive` 与 `until` / `from`）；`policy.js` 是唯一回源判定（年度 `releaseMonth` + `until` 归档）；`store.js` 按栏目分文件（`cache/livelihood-security/catalogs/<key>.json`）；`service.js` 现算 24 个计算口径（`diff` / `ratio_pct` / `months` / `per_capita`，不落盘）；取数复用父目录的 `source`（同一年度库）、限流复用父目录的 `queue` |
| `lib/industry/**` | industry | `config.js` 读 `config/industry.json`（校验 32 位编码与重复 key）；`policy.js` 是唯一回源判定（栏目发布日 + 1、2 月合并 + `until`）；`source.js` 请求国家数据月度库（`code=1`、期别如 `2026-09`）；`store.js` 按栏目分文件（`cache/industry/catalogs/<key>.json`）；`service.js` 出 overview 矩阵（41 行业 × 3 口径）与 10 条 PMI 序列；限流在本模块内（统计局 1200 ms + 60 秒冷却 + 10 分钟重试间隔），不依赖 `lib/livelihood/queue` |
| `config/indicators.json` | macro | 宏观栏目 / 指标 / 分段 / 发布日 / 兜底的唯一事实来源 |
| `config/livelihood.json` | livelihood | 人口与婚育 4 个栏目 / 20 个指标（16 个原值 + 4 个 `derive` 计算值；含 `kind: percent` 的抚养比与 `until` 归档的预期寿命）/ 单位 / 历史起点的唯一事实来源 |
| `config/income.json` | livelihood-income | 收支 6 个栏目 / 23 个指标 / 口径说明 / 历史起点（2013）的唯一事实来源 |
| `config/deposit.json` | livelihood-deposit | 存款 5 个口径分组 / 7 个指标 / 表名与行名 / 人口分母编码 / 历史起点（2015）的唯一事实来源 |
| `config/retail.json` | livelihood-retail | 社零 8 个栏目 / 26 个指标 / 6 个分组 / 计算口径 `derive` / 历史起点（2015）的唯一事实来源 |
| `config/employment.json` | livelihood-employment | 就业 3 个栏目 / 19 个指标（含 3 个 `derive`）/ 6 个分组 / 双频次 `freq` 与 `releaseMonth` / `until` 归档 / 历史起点（月度 2018-01、年度 1978）的唯一事实来源 |
| `config/security.json` | livelihood-security | 养老医保 9 个栏目 / 69 个指标（含 24 个 `derive`）/ 8 个分组 / `from` 与 `until` 归档 / 历史起点（1990）的唯一事实来源 |
| `config/industry.json` | industry | 工业行业运行 5 个栏目（output / revenue / profit / mfg_pmi / nonmfg_pmi）/ 41 个大类行业 × 3 个口径 + 10 个 PMI 分项 / 6 个分组 / 各自发布规则（`day: 15`、`day: 27`、`day: 'eom'`、`skipMonths`）/ 历史起点（2018-01）的唯一事实来源 |
| `public/index.html` + `home.css` | 共用 | 模块选择入口 |
| `public/housing/`、`public/macro/`、`public/lpr/`、`public/livelihood/`、`public/livelihood/income/`、`public/livelihood/deposit/`、`public/livelihood/retail/`、`public/livelihood/employment/`、`public/livelihood/security/`、`public/industry/` | 各自 | 每个页面自带 html / css / app.js，互不引用 |
| `public/vendor/echarts.min.js` | 共用 | 所有模块共用一份本地 ECharts，**禁止 CDN** |
| `data/periods.json` | housing | 固化数据集（189 个月），随仓库提交 |
| `.cache/` | 运行时 | `housing` 的解析结果与月报原文、`macro/` 的月缓存、`lpr/` 的全量缓存、`livelihood/` 的年度缓存、`livelihood-income/` 的收支年度缓存、`livelihood-deposit/` 的存款年度缓存、`livelihood-retail/` 的社零栏目缓存、`livelihood-employment/` 的就业栏目缓存、`livelihood-security/` 的养老医保栏目缓存、`industry/` 的行业运行栏目缓存，可随时删 |

- 新增模块时同样落在 `lib/<module>/` 与 `public/<module>/`，API 用 `/api/<module>/*` 前缀，并在入口页加入口卡片。
- 模块之间**不互相 require**。共用能力要么下沉到各自模块内，要么新增 `lib/shared/`，不要跨模块取私有实现。
- 同一模块内的子页面可以 require 父目录的实现：`lib/livelihood/income/` 就复用 `lib/livelihood/{source,queue,policy}.js`（同一年度库、同一套限流），只把配置与缓存目录独立出来；`lib/livelihood/deposit/` 只复用父目录的 `queue`（限流），取数完全自己实现（换成了央行站点）；`lib/livelihood/retail/` 也只复用父目录的 `queue`，取数自己走月度库；`lib/livelihood/employment/` 同样只复用父目录的 `queue`，取数自己走月度库 + 年度库；`lib/livelihood/security/` 复用父目录的 `source`（同一年度库）与 `queue`（限流），配置、缓存目录、路由独立。注意五个子模块的路由都必须排在 `/api/livelihood/` 前缀分支**之前**，否则会被婚育模块的分发吃掉。

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
- 临时文件：探测脚本、一次性验证脚本、临时截图、中间产物（JSON / 日志）一律写在项目根目录的 `.temp/` 里。`.temp/` 已被 git 忽略（只跟踪 `.temp/.gitignore`，用它保证 clone 下来就有这个目录），所以放进去的东西不会误提交；用完随手删，不要散落在根目录、`.cache/`、`docs/` 或 `public/`。

## 3. 数据与缓存（通用）

- **缓存优先**：有本地数据就用本地数据，只有在缺数据 / 过了发布日 / 用户手动刷新时才回源。
- **拉取模型**：首次运行（本地没有缓存）一次性把历史拉全写入本地，再渲染；之后每次打开只核对应发布期别是否已落缓存——有新一期就补进去，没发布就直接读缓存，不做全量重拉。民生模块是同一模型的年度版（期别换成「年」）。
- **服务端代取**：统计局站点有 WAF，浏览器直连会 403；央行站点同样不接受直连，所有请求都走 `server.js`。
- **首屏不等上游**：区间里有缓存就先出图，回源放后台，前端只消费服务端给的 `stale` / `refreshing` 字段；首次运行无缓存时才等拉全。
- **落后太多就等补齐**：某指标最新缓存月落后应发布期别 3 期以上（如包放半年才打开）时同步补齐再渲染，不先摆过期图；这与上方「不等上游」并不矛盾——后台补数只用于当期缺口。
- **失败回退缓存**：上游失败或返回非预期内容（非 JSON / 非 HTML）→ 回退本地数据并标 `stale: true`，**不抛 500、不返回空数组**。
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

- 只提交源码：`.gitignore` 覆盖 `node_modules/`、`.cache/`、`release/`、`.temp/`；打包脚本（`build.bat` + `packaging/build.ps1`）不含本机路径，随仓库提交。
- `data/periods.json` 与 `config/indicators.json`、`config/livelihood.json`、`config/income.json`、`config/deposit.json`、`config/retail.json`、`config/employment.json`、`config/security.json`、`config/industry.json` 属于数据/配置资产，**随代码提交**。
- 打包：双击根目录 `build.bat`（或 `powershell -File packaging\build.ps1`）产出 `release/中国经济统计数据看板/` 与 `release/china-economic-stats-dashboard-v<版本>-<系统标签>.zip`；zip 名必须纯 ASCII（中文附件名会被 GitHub 静默丢弃），目录名用中文。
- 分发包必须带 `.cache/macro/`（宏观历史缓存，约 0.2 MB）并且**剔除其中的 `_meta.json`**：带上缓存后对方首次打开只补最近几期；而 `_meta.json` 是本机回源时间戳（10 分钟冷却），进包会抑制对方首次核对。`.cache/lpr/` 与 `.cache/livelihood/`、`.cache/livelihood-income/`、`.cache/livelihood-deposit/`、`.cache/livelihood-retail/`、`.cache/livelihood-employment/`、`.cache/livelihood-security/`、`.cache/industry/`（行业运行，约 0.2 MB）同理（都随包带、都剔 `_meta.json`）。
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
- 把央行新闻稿的「年初至今累计增量」说成当月新增，或把本页差分的计算值标成官方发布值
- 把「比上年增长」当成实际增速，或用 CPI 自行折算出一个官方并不发布的实际增速
- 提交 exe、缓存目录、打包产物
- 改动宏观模块却不看 `README.md` 的「宏观经济模块」章节
- 改动存款模块却不看 `README.md` 的「居民存款与人均存款」章节
- 改动行业运行模块却不看 `README.md` 的「工业行业运行」章节，或把 41 个行业的增加值 / 营收 / 利润 / PMI 合成一个「景气指数」
- 把临时脚本 / 截图 / 中间产物丢在根目录、`.cache/`、`docs/` 或 `public/`（统一放 `.temp/`）
