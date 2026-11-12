@echo off
chcp 65001 >nul
setlocal

title 中国经济统计数据看板

rem 切到脚本所在目录，双击运行时也能找到 server.js
cd /d "%~dp0"

set "PORT=5173"
if not "%DASH_PORT%"=="" set "PORT=%DASH_PORT%"
if not "%NBS_PORT%"=="" set "PORT=%NBS_PORT%"

echo.
echo   中国经济统计数据看板
echo   70 城房价 + 宏观经济 + 房贷利率 LPR + 人口与婚育 + 收支 + 存款 + 社零 + 就业 + 养老医保 + 行业运行 + 区域经济 + 房地产开发 十二个看板
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

rem 端口上已经有东西在听：先确认它真的是本看板，而不是别的程序占了端口
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if errorlevel 1 goto :start

powershell -NoProfile -Command "try { $c = [Net.WebRequest]::Create('http://127.0.0.1:%PORT%/api/health'); $c.Timeout = 1500; $c.GetResponse().Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo   [i] 服务已在运行，直接打开页面
  start "" "http://127.0.0.1:%PORT%"
  timeout /t 1 >nul
  exit /b 0
)

echo   [x] 端口 %PORT% 被其它程序占用了
echo       换个端口再试： set DASH_PORT=5180 ^&^& start.bat
echo.
pause
exit /b 1

:start
if not exist "data\periods.json" (
  echo   [!] 没找到 data\periods.json
  echo       首次运行需要从统计局抓取 2011 年至今的 70 城月报，约 2-4 分钟
  echo.
)

echo   [i] 启动本地服务...
echo   [i] 浏览器稍后自动打开： http://127.0.0.1:%PORT%
echo   [i] 关闭本窗口即停止服务，Ctrl+C 也可以
echo.

rem 延迟 3 秒再开浏览器，等端口真正监听起来
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:%PORT%'"

node server.js

echo.
echo   服务已停止。
pause
exit /b 0

:no_node
echo   [x] 没有找到 Node.js
echo       请先安装 Node.js 20 或更高版本： https://nodejs.org/
echo.
pause
exit /b 1
