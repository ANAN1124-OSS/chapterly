@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 找不到 Node.js：章回开发版需要 Node.js 22 或更高版本。
  echo 先到 https://nodejs.org/ 安装，装好后重新双击本文件。
  echo 安装版不需要 Node.js，从桌面快捷方式或开始菜单打开即可。
  pause
  exit /b 1
)
node scripts\start.js
set "code=%errorlevel%"
if not "%code%"=="0" (
  echo.
  echo 章回启动失败，退出码 %code%。
  echo 请把上面的错误信息发给开发者。
  pause
  exit /b %code%
)
