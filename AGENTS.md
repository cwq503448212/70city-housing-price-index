# AGENTS.md

**china-economic-stats-dashboard** —— 零依赖的 Node 本地看板：一个进程、十一个模块、一份可删的 JSON 缓存；数据全部由服务端代取，首次打开拉全历史，之后只核对应发布期别。

> 本文件只写**动手前必须知道的约束与红线**。数据源核实结论、口径铁律、各模块缓存模型与计算值定义都在 `README.md` 的「模块一 ~ 模块十一」章节和源码注释里，改哪个模块先读对应章节与 `config/*.json`。
>
> 写代码时**不要**在这里追加实现细节（缓存路径、限流参数、指标数量、某年某地口径修正等）——那些写在 README 或代码注释里，写这里必然过时。

## 1. 模块索引

| 模块 | 代码 | API 前缀 | 页面 |
|---|---|---|---|
| 房价（70 城指数） | `lib/housing/nbs70.js` | `/api/nbs70` | `/housing/` |
| 宏观经济 | `lib/macro/` | `/api/macro/` | `/macro/` |
| 房贷利率 LPR | `lib/lpr/` | `/api/lpr/` | `/lpr/` |
| 人口与婚育 | `lib/livelihood/` | `/api/livelihood/` | `/livelihood/` |
| 人均收入与支出 | `lib/livelihood/income/` | `/api/livelihood/income-expenditure` | `/livelihood/income/` |
| 居民存款 | `lib/livelihood/deposit/` | `/api/livelihood/reserve-deposit` | `/livelihood/deposit/` |
| 社会消费品零售 | `lib/livelihood/retail/` | `/api/livelihood/retail` | `/livelihood/retail/` |
| 就业 | `lib/livelihood/employment/` | `/api/livelihood/employment` | `/livelihood/employment/` |
| 养老医保 | `lib/livelihood/security/` | `/api/livelihood/security` | `/livelihood/security/` |
| 工业行业运行 | `lib/industry/` | `/api/industry/` | `/industry/` |
| 区域经济（分省 GDP） | `lib/region/` | `/api/region/` | `/region/` |

上表与 README 的「模块一 ~ 模块十一」同序。每个模块的**唯一事实来源**是 `config/<module>.json`：指标编码、分组、发布规则、`until` / `from` 归档、`derive` 计算口径都在那里。新增或改动指标**先改配置**，不要在代码里写死编码、指标数量或起止年份。

## 2. 目录与边界

- 新增模块落 `lib/<module>/` + `public/<module>/`，API 用 `/api/<module>/*`，并在 `public/index.html` 加入口卡片。
- 模块之间**不互相 require**；共用能力下沉到本模块内，或新建 `lib/shared/`。
- 同一模块的子页面可以 require 父目录的公共件（现有复用关系见 README「目录结构」，新增复用就同步补那里）。
- HTTP 只由 `server.js` 一个进程分发，不新开监听端口。新增的子前缀路由（如 `/api/livelihood/xxx`）**必须排在 `/api/livelihood/` 这类更宽前缀的分支之前**，否则会被吞掉；`server.js` 对应路由段上已有注释提醒。

## 3. 硬约束

- 运行时 Node >= 20、CommonJS；后端只用 Node 内置模块，**零 npm 依赖**，不引入需要编译的包。
- 前端原生 HTML/CSS/JS + `public/vendor/echarts.min.js`：禁 React/Vue、禁 CDN、禁打包构建；图表单行通栏，配色红涨绿跌。
- 新页面必须能通过目录访问（`/module/`），页面内资源一律写相对路径（`../vendor/echarts.min.js`、`./app.js`），不写绝对路径。
- 存储只用 JSON 文件，缓存目录可随时删、删后按需重建。
- `.bat` 必须 **UTF-8 无 BOM + CRLF**、首行 `chcp 65001 >nul`；`.ps1` 必须 **UTF-8 with BOM**（PS 5.1 会按 GBK 解码无 BOM 文件）。长逻辑写在 `.ps1`，`.bat` 只做转发。
- 临时探测脚本、截图、中间产物一律放 `.temp/`（已 git 忽略），用完即删；不要落在根目录、`.cache/`、`docs/`、`public/`。
- 前端请求一律相对根路径 `/api/...`，不硬编码端口或 `127.0.0.1`；`localStorage` 里的筛选默认值改动时必须同步升级键名（如 `.v2` → `.v3`）。

## 4. 数据红线

- 前端不直连上游（统计局 / 央行）：WAF 会拦，所有请求经 `server.js` 代取。
- 缓存优先、首屏不等上游；上游失败或返回非预期内容 → 回退缓存并标 `stale: true`，**不抛 500、不返回空数组**。
- 缺值就是 `null`：不插值、不补 0、不自行加权合成、不把缺失画成 0；一条序列只来自单一数据源。
- 口径不混画：同比 / 环比 / 定基、名义 / 实际、扩散指数（50 为荣枯线）与增速（0 为持平）分轴分开；所有计算值必须在图注与表头声明「本页计算」。
- 编码、数据、发布日期一律有据可查（`probe.js` 探测 + 官方口径交叉校验），禁止猜编码、禁止占位假数据。
- 其余共用机制（限流、冷却、落后补齐、错误码等）以 README「十一个看板共用的机制」为准，改动前先读。

## 5. 改完后端必须重启进程

`start.bat` 发现端口已在监听就只打开浏览器、不再启动 node；Node 没有热重载。所以改过 `server.js` 或 `lib/**` 之后不重启，新增的 `/api/*` 会一直返回 404「未知接口」，前端显示「接口返回失败」。

- 判据：监听端口（默认 5173）的进程启动时间早于文件 mtime，就是在跑旧代码。
- 验证要直连新接口：`/api/health` 被旧代码也会返回 200，不能作为「改动已生效」的依据。
- 重启方式：关掉服务窗口重新双击 `start.bat`，或直接 `node server.js`。

## 6. 提交与发布

- 只提交源码：`.cache/`、`.temp/`、`release/`、`node_modules/`、exe 一律不进仓库；`data/periods.json` 与 `config/*.json` 属于数据资产，随代码提交。
- 仓库级 git 身份为 `cwq503448212` + GitHub noreply 邮箱；提交前确认不含公司邮箱 / 真名拼音。
- 提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` 前缀 + 一句中文说明，一次提交一件事。
- 发布：版本号以 `package.json` 为准，打 Tag `vX.Y.Z` 并建 GitHub Release；同时核对 README 模块表、对应截图与 Release 说明是否同步。打包产物与分发包内容见 README「打包给别人」（zip 名必须纯 ASCII）。
- README 必须持续保持：两种用法（源码版 / 一键包版）、数据来源与稳定性声明、缓存目录说明。

### 6.1 推送通路（本机网络特殊）

远端配置的 `ssh://git@ssh.github.com:443` 在本机**连不通**，`git push origin main` 只会超时——这是网络限制，不是仓库权限问题，**不要改远端、不要重配 SSH key、不要反复重试**。固定走「HTTPS + 本地 SOCKS5 + HTTP/1.1」：

```powershell
$env:GIT_TERMINAL_PROMPT="0"
git -c http.proxy=socks5://127.0.0.1:1080 -c http.version=HTTP/1.1 push https://github.com/cwq503448212/china-economic-stats-dashboard.git main
```

- **端口以实际监听为准**：`1080` 只是当前值，代理客户端重启后会漂移；先查系统代理 `HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyServer`，或用 `Get-NetTCPConnection -State Listen` 核对。
- 必须用 `socks5://`（本地 DNS，`socks5h://` 常超时），并加 `http.version=HTTP/1.1`（否则报 `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`，与证书、权限无关）。
- 连通性最多验一次：`curl.exe -s -o NUL -w "%{http_code}" --proxy socks5://127.0.0.1:<port> "https://github.com/cwq503448212/china-economic-stats-dashboard.git/info/refs?service=git-receive-pack"` 返回 `401` 即通路正常（未带凭据的预期响应）。**禁止循环重试本地 SOCKS 端口**，会把桌面代理客户端打崩。
- 裸 URL 推送不会更新远端跟踪引用：push 成功后执行 `git update-ref refs/remotes/origin/main <新 commit>`，再用 GitHub API 核对 `commits/main` 的 sha。
- 凭据由 Windows 凭据管理器提供，token 不写进任何文件或命令行；推 tag 走同一条命令（末尾换成 `vX.Y.Z`）。
- 输出里出现 `<old>..<new>  main -> main` 即推送成功。PowerShell 会把 git 的 stderr 渲染成报错、`ExitCode` 变成 1，不要据此重复推送。

## 7. 禁止

- 把统计局站点内部接口说成官方开放 API；回退到已被 WAF 拦截的 EasyQuery 路由
- 高频轮询、遍历指标树「预热」、绕过限流 / 验证码；前端直连上游域名
- 编造编码 / 数据 / 发布日期，插值补齐，把缺失画成 0
- 把累计口径说成当月值，或把本页计算值标成官方发布值
- 把「比上年增长」当实际增速，或用 CPI 自行折算官方并不发布的实际增速
- 把 41 个行业的增加值 / 营收 / 利润 / PMI 合成「景气指数」；把 31 省 GDP 相加当全国总量
- 提交 exe、缓存目录、打包产物；把临时脚本或截图丢在 `.temp/` 之外
- 改某个模块却不读 README 对应章节与 `config/*.json`
