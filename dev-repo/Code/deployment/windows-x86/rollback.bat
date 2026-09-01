@echo off
chcp 65001 >nul
title Ceastar PMS 应用版本回退
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rollback.ps1"
if errorlevel 1 (
  echo.
  echo [失败] Ceastar PMS 应用版本回退未完成，请查看上方错误详情。
) else (
  echo.
  echo [成功] Ceastar PMS 应用版本回退已完成。
)
pause
