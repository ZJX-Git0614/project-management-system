@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Repairing the Ceastar PMS MPP export service...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-mpp-export-service.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo The MPP export service repair failed. Review the message above.
) else (
  echo.
  echo The MPP export service repair completed successfully.
)

pause
exit /b %EXIT_CODE%
