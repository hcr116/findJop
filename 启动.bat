@echo off
chcp 65001 >nul
title BOSS 岗位追踪
cd /d "%~dp0"

echo.
echo   ============================================
echo     BOSS 岗位追踪器
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] 没找到 Node.js
  echo.
  echo   这个工具需要 Node.js 才能运行。
  echo   请到 https://nodejs.org 下载安装 LTS 版本，装完重新双击本文件。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright-core" (
  echo   首次运行，正在安装依赖（只需一次）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [!] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

echo   启动中...
echo.
node src\cli.mjs serve --open

pause
