@echo off
chcp 65001 >nul
setlocal
set "APP=%~dp0app"
echo 正在启动「大肥鱼桌宠」开发版（源码直跑，改代码自动热更新）...
echo.
echo 注意：安装版和开发版共用一个数据目录，请先关掉安装版再运行本脚本。
if not exist "%APP%\node_modules\electron\dist\electron.exe" goto noelectron
start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%"
goto :eof
:noelectron
echo.
echo [错误] 没找到 Electron。请先在这个文件夹的 app 目录里执行一次：npm install
pause
