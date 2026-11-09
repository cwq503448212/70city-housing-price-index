# 生成便携分发包：把项目 + 本机 node.exe 打成「解压双击就能用」的文件夹和 zip
#
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File packaging\build.ps1
#
# 想指定别的 node.exe：
#   $env:NODE_EXE = 'D:\node20\node.exe'; powershell -ExecutionPolicy Bypass -File packaging\build.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$name = '70城房价看板'
$outDir = Join-Path $root 'release'
$pkg = Join-Path $outDir $name
$zip = Join-Path $outDir ($name + '.zip')

# 内置的 Node 运行时：优先 NODE_EXE 环境变量，否则用系统 PATH 里的 node
$nodeExe = $env:NODE_EXE
if (-not $nodeExe) { $nodeExe = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path $nodeExe)) { throw ('找不到 node.exe：' + $nodeExe) }

$nodeVer = (@(& $nodeExe -v) -join '').Trim()
Write-Host ('[1/4] Node 运行时：' + $nodeExe + '  ' + $nodeVer)

if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Path $pkg -Force | Out-Null

Copy-Item $nodeExe (Join-Path $pkg 'node.exe')
Copy-Item (Join-Path $root 'server.js') $pkg
Copy-Item (Join-Path $root 'package.json') $pkg
foreach ($d in @('lib', 'public', 'data', 'docs')) {
  Copy-Item (Join-Path $root $d) (Join-Path $pkg $d) -Recurse
}
# 便携版专用的启动脚本和使用说明，放在 packaging 里跟代码一起维护
Copy-Item (Join-Path $PSScriptRoot 'start.bat') $pkg
Copy-Item (Join-Path $PSScriptRoot '使用说明.txt') $pkg

# 运行期产物不该进分发包
foreach ($junk in @('.cache', 'node_modules')) {
  $p = Join-Path $pkg $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Write-Host '[2/4] 已拷贝项目文件'

if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $pkg, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
Write-Host '[3/4] 已压缩'

$files = Get-ChildItem $pkg -Recurse -File
Write-Host ('[4/4] 完成：' + $files.Count + ' 个文件，' + ('{0:N1}' -f (($files | Measure-Object Length -Sum).Sum / 1MB)) + ' MB，压缩后 ' + ('{0:N1}' -f ((Get-Item $zip).Length / 1MB)) + ' MB')
Write-Host ('      文件夹：' + $pkg)
Write-Host ('      压缩包：' + $zip)
