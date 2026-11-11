# 生成便携分发包：把项目 + 本机 node.exe 打成「解压双击就能用」的文件夹和 zip
#
# 用法（在项目根目录执行，或直接双击根目录的 build.bat）：
#   powershell -ExecutionPolicy Bypass -File packaging\build.ps1
#   powershell -ExecutionPolicy Bypass -File packaging\build.ps1 -SysTag 'win7-win11'
#
# 想指定别的 node.exe：
#   powershell -ExecutionPolicy Bypass -File packaging\build.ps1 -NodeExe 'D:\soft\nvm\v20.12.2\node.exe'
#   （也可以用环境变量：set NODE_EXE=D:\node20\node.exe）

param(
  [Parameter(Position = 0)][string]$SysTag = 'win10-win11',
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$name = '中国经济统计数据看板'
$outDir = Join-Path $root 'release'
$pkg = Join-Path $outDir $name

# zip 用纯 ASCII 名：GitHub Release 附件不接受中文，会被静默删掉；目录仍用中文名，解压后看着友好
# 版本号用正则从 package.json 取，避开 PS 5.1 按 GBK 解码 UTF-8 的坑；支持的系统范围用 -SysTag 控制
$pkgVersion = (Select-String -Path (Join-Path $root 'package.json') -Pattern '"version"\s*:\s*"([^"]+)"').Matches[0].Groups[1].Value
$zip = Join-Path $outDir ('china-economic-stats-dashboard-v' + $pkgVersion + '-' + $SysTag + '.zip')

# 内置的 Node 运行时：优先 -NodeExe 参数，其次 NODE_EXE 环境变量，最后用系统 PATH 里的 node
if (-not $NodeExe) { $NodeExe = $env:NODE_EXE }
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path $NodeExe)) { throw ('找不到 node.exe：' + $NodeExe) }

$nodeVer = (@(& $NodeExe -v) -join '').Trim()
if ($nodeVer -match '^v([0-9]+)\.' -and [int]$matches[1] -lt 20) { throw ('内置运行时要 Node 20+，当前是 ' + $nodeVer + '；Win7/8 已不支持') }
Write-Host ('[1/4] Node 运行时：' + $NodeExe + '  ' + $nodeVer)

# 旧产物可能正被占用（包里的看板还在跑），删不掉时给一句人话，而不是抛原始异常
if (Test-Path $zip) {
  try { Remove-Item $zip -Force } catch { throw ('旧的 zip 删不掉：' + $zip + '，关掉正在解压或预览它的窗口后重试') }
}
if (Test-Path $pkg) {
  try { Remove-Item $pkg -Recurse -Force } catch { throw ('旧的 ' + $pkg + ' 删不掉，里面的看板可能还在运行：关掉它启动的黑窗口后重试') }
}
New-Item -ItemType Directory -Path $pkg -Force | Out-Null

Copy-Item $NodeExe (Join-Path $pkg 'node.exe')
foreach ($f in @('server.js', 'package.json', 'probe.js', 'README.md')) {
  Copy-Item (Join-Path $root $f) $pkg
}
# 十一个看板的代码、配置、页面、固化数据集与截图（docs 只被 README 引用）
foreach ($d in @('lib', 'config', 'public', 'data', 'docs')) {
  Copy-Item (Join-Path $root $d) (Join-Path $pkg $d) -Recurse
}
# 便携版专用的启动脚本和使用说明，放在 packaging 里跟代码一起维护
Copy-Item (Join-Path $PSScriptRoot 'start.bat') $pkg
Copy-Item (Join-Path $PSScriptRoot '使用说明.txt') $pkg

# 运行期产物和开发用的东西不该进分发包
foreach ($junk in @('.cache', 'node_modules', 'release', 'AGENTS.md')) {
  $p = Join-Path $pkg $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

# 带上一份宏观历史缓存：对方首次打开只需补最近几期，不用全量回源（约 0.2 MB）
# _meta.json 只是本机的回源尝试时间戳（10 分钟冷却），进包会让对方首次核对被跳过，必须剔掉
$macroSrc = Join-Path $root '.cache\macro'
if (Test-Path $macroSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $macroSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\macro') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $months = Get-ChildItem (Join-Path $pkg '.cache\macro') -Recurse -File -Filter '20??-??.json'
  $latest = ($months | ForEach-Object { $_.BaseName } | Sort-Object -Descending | Select-Object -First 1)
  $indCount = (Get-ChildItem (Join-Path $pkg '.cache\macro') -Directory).Count
  Write-Host ('      + 宏观缓存：' + $indCount + ' 个指标 / ' + $months.Count + ' 个月度文件，最新 ' + $latest)
} else {
  Write-Host '      ! 未找到 .cache\macro：包里不带宏观历史，对方首次打开会全量拉取'
}

# 同样带上一份 LPR 全量缓存（约 90 期 / 几 KB，按自然年分段约 8 次请求即可拉全，带包只是让首屏秒出）
# _meta.json 同理剔掉，别把本机的回源冷却时间戳带进包
$lprSrc = Join-Path $root '.cache\lpr'
if (Test-Path $lprSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $lprSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\lpr') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  Write-Host '      + LPR 缓存：lpr.json（全历史一期不落）'
} else {
  Write-Host '      ! 未找到 .cache\lpr：包里不带 LPR 缓存，对方首次打开会现场拉全（几秒钟）'
}

# 民生（人口与婚育）年度缓存：每年一个小文件，16 个指标 × 近 50 年也很轻，带上让首屏直接出图
# _meta.json 同理剔掉（每个指标目录一份，含着本机的回源尝试时间戳与上次错误）
$liveSrc = Join-Path $root '.cache\livelihood'
if (Test-Path $liveSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $liveSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\livelihood') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $years = Get-ChildItem (Join-Path $pkg '.cache\livelihood') -Recurse -File -Filter '????.json'
  $liveInd = (Get-ChildItem (Join-Path $pkg '.cache\livelihood') -Directory).Count
  $liveLatest = ($years | ForEach-Object { $_.BaseName } | Sort-Object -Descending | Select-Object -First 1)
  Write-Host ('      + 民生缓存：' + $liveInd + ' 个指标 / ' + $years.Count + ' 个年度文件，最新 ' + $liveLatest)
} else {
  Write-Host '      ! 未找到 .cache\livelihood：包里不带民生缓存，对方首次打开会现场拉全（几秒钟）'
}

# 人均收支年度缓存：23 个指标 × 13 年，同样剔 _meta.json（否则对方首次核对会被冷却时间戳跳掉）
$incomeSrc = Join-Path $root '.cache\livelihood-income'
if (Test-Path $incomeSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $incomeSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\livelihood-income') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $incomeYears = Get-ChildItem (Join-Path $pkg '.cache\livelihood-income') -Recurse -File -Filter '????.json'
  $incomeInd = (Get-ChildItem (Join-Path $pkg '.cache\livelihood-income') -Directory).Count
  $incomeLatest = ($incomeYears | ForEach-Object { $_.BaseName } | Sort-Object -Descending | Select-Object -First 1)
  Write-Host ('      + 收支缓存：' + $incomeInd + ' 个指标 / ' + $incomeYears.Count + ' 个年度文件，最新 ' + $incomeLatest)
} else {
  Write-Host '      ! 未找到 .cache\livelihood-income：包里不带收支缓存，对方首次打开会现场拉全（六个请求）'
}
# 居民存款年度缓存：一个年一个文件（12 个月 × 3 行原值）+ 人口分母，几十 KB，带上让首屏直接出图
# _meta.json 同样剔掉（它带着本机的回源冷却时间戳与上次错误）
$depositSrc = Join-Path $root '.cache\livelihood-deposit'
if (Test-Path $depositSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $depositSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\livelihood-deposit') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $depositYears = Get-ChildItem (Join-Path $pkg '.cache\livelihood-deposit\years') -File -Filter '????.json'
  $depositLatest = ($depositYears | ForEach-Object { $_.BaseName } | Sort-Object -Descending | Select-Object -First 1)
  Write-Host ('      + 存款缓存：' + $depositYears.Count + ' 个年度文件，最新 ' + $depositLatest)
} else {
  Write-Host '      ! 未找到 .cache\livelihood-deposit：包里不带存款缓存，对方首次打开会现场拉全（约 45 秒）'
}
# 社零栏目缓存：8 个栏目文件（约 2.3 千个数据点），轻量，带上让首屏直接出图
# _meta.json 同样剔掉（它带着本机的回源冷却时间戳与上次错误）
$retailSrc = Join-Path $root '.cache\livelihood-retail'
if (Test-Path $retailSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $retailSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\livelihood-retail') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $retailCats = Get-ChildItem (Join-Path $pkg '.cache\livelihood-retail\catalogs') -File -Filter '*.json'
  $retailKB = '{0:N1}' -f (($retailCats | Measure-Object Length -Sum).Sum / 1KB)
  Write-Host ('      + 社零缓存：' + $retailCats.Count + ' 个栏目文件，' + $retailKB + ' KB')
} else {
  Write-Host '      ! 未找到 .cache\livelihood-retail：包里不带社零缓存，对方首次打开会现场拉全（8 个请求，约 9 秒）'
}
# 就业缓存：3 个栏目文件（月度失业率 + 年度农民工 / 登记失业，约 800 个数据点），轻量，带上让首屏直接出图
# _meta.json 同样剔掉（它带着本机的回源冷却时间戳与上次错误）
$employmentSrc = Join-Path $root '.cache\livelihood-employment'
if (Test-Path $employmentSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $employmentSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\livelihood-employment') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $empCats = Get-ChildItem (Join-Path $pkg '.cache\livelihood-employment\catalogs') -File -Filter '*.json'
  $empKB = '{0:N1}' -f (($empCats | Measure-Object Length -Sum).Sum / 1KB)
  Write-Host ('      + 就业缓存：' + $empCats.Count + ' 个栏目文件，' + $empKB + ' KB')
} else {
  Write-Host '      ! 未找到 .cache\livelihood-employment：包里不带就业缓存，对方首次打开会现场拉全（3 个请求，约 5 秒）'
}
# 养老医保栏目缓存：9 个栏目文件（45 条原值序列 / 约 1100 个数据点），轻量，带上让首屏直接出图
# _meta.json 同样剔掉（它带着本机的回源冷却时间戳与上次错误）
$securitySrc = Join-Path $root '.cache\livelihood-security'
if (Test-Path $securitySrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $securitySrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\livelihood-security') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $secCats = Get-ChildItem (Join-Path $pkg '.cache\livelihood-security\catalogs') -File -Filter '*.json'
  $secKB = '{0:N1}' -f (($secCats | Measure-Object Length -Sum).Sum / 1KB)
  Write-Host ('      + 养老医保缓存：' + $secCats.Count + ' 个栏目文件，' + $secKB + ' KB')
} else {
  Write-Host '      ! 未找到 .cache\livelihood-security：包里不带养老医保缓存，对方首次打开会现场拉全（9 个请求，约 10 秒）'
}
# 行业运行栏目缓存：5 个栏目文件（133 条原值序列 / 约 1.2 万个数据点，约 0.2 MB），
# 带上后对方首次打开只需补最近几期；_meta.json 同样剔掉（它带着本机的回源冷却时间戳）
$industrySrc = Join-Path $root '.cache\industry'
if (Test-Path $industrySrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $industrySrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\industry') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $indCats = Get-ChildItem (Join-Path $pkg '.cache\industry\catalogs') -File -Filter '*.json'
  $indKB = '{0:N1}' -f (($indCats | Measure-Object Length -Sum).Sum / 1KB)
  Write-Host ('      + 行业运行缓存：' + $indCats.Count + ' 个栏目文件，' + $indKB + ' KB')
} else {
  Write-Host '      ! 未找到 .cache\industry：包里不带行业运行缓存，对方首次打开会现场拉全（5 个请求，约 10 秒）'
}
# 分省 GDP 缓存：31 个省文件（每省 22 项指标 × 1992 起，约 1.4 万个数据点，
# 带上后对方首次打开不必逐省拉 31 次；_meta.json 同样剔掉（它按「省 + 栏目」记冷却时间戳）
$regionSrc = Join-Path $root '.cache\region'
if (Test-Path $regionSrc) {
  New-Item -ItemType Directory -Path (Join-Path $pkg '.cache') -Force | Out-Null
  Copy-Item $regionSrc (Join-Path $pkg '.cache') -Recurse
  Get-ChildItem (Join-Path $pkg '.cache\region') -Recurse -File -Filter '_meta.json' | Remove-Item -Force
  $regionFiles = Get-ChildItem (Join-Path $pkg '.cache\region') -File -Filter '????????????.json'
  $regionKB = '{0:N1}' -f (($regionFiles | Measure-Object Length -Sum).Sum / 1KB)
  Write-Host ('      + 区域经济缓存：' + $regionFiles.Count + ' 个省文件，' + $regionKB + ' KB')
} else {
  Write-Host '      ! 未找到 .cache\region：包里不带分省 GDP 缓存，对方首次打开会逐省拉 31 次（约 40 秒）'
}
Write-Host '[2/4] 已拷贝项目文件'

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $pkg, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
Write-Host '[3/4] 已压缩'

$files = Get-ChildItem $pkg -Recurse -File
Write-Host ('[4/4] 完成：' + $files.Count + ' 个文件，' + ('{0:N1}' -f (($files | Measure-Object Length -Sum).Sum / 1MB)) + ' MB，压缩后 ' + ('{0:N1}' -f ((Get-Item $zip).Length / 1MB)) + ' MB')
Write-Host ('      文件夹：' + $pkg)
Write-Host ('      压缩包：' + $zip)
Write-Host '      上传 GitHub Release 时附件用这个纯英文 zip 名，中文名会被静默丢掉。'
