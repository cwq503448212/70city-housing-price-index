@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem  One-click portable package builder.
rem  All logic lives in packaging\build.ps1 (kept ASCII here on purpose:
rem  cmd may misparse multi-byte text in long .bat files).
rem
rem  Double-click = build release\ + zip.
rem    build.bat                 default system tag win10-win11
rem    build.bat win7-win11      only the zip file name changes
rem    set NODE_EXE=D:\node20\node.exe   bundle that node.exe instead
rem
rem  Output:
rem    release\<app folder>\                                  double-click start.bat
rem    release\china-economic-stats-dashboard-v<ver>-<tag>.zip  ship this
rem ---------------------------------------------------------------

setlocal
cd /d "%~dp0"

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\build.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\build.ps1" -SysTag "%~1"
)

if errorlevel 1 (
  echo.
  echo   [x] Build failed. See the message above.
  pause
  exit /b 1
)

echo.
pause
exit /b 0
