@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0assistant-services.ps1" -Interactive
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo 智能助手服务管理执行失败，错误码：%EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%
