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
rem 审计修复 #56（O5）：只查「装没装」不够 —— 旧 Node（<22）会在后面以语法错误失败，
rem 提示远离原因。这里真读主版本号，低版本直接给出可执行的提示。
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 版本过低：章回开发版需要 Node.js 22 或更高版本（当前版本：
  node -v
  echo ）。
  echo 先到 https://nodejs.org/ 安装新版，装好后重新双击本文件。
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
