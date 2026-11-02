@echo off
setlocal
if /i "%~1"=="--ensure" (
  node "%~dp0scripts\mcp-ensure.cjs"
  exit /b
)
set "NODE_OPTIONS="
set "NODE_PATH="
set "PYTHONHOME="
set "PYTHONPATH="
set "WEFLOW_PYTHON="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mcp.ps1" %*
exit /b %errorlevel%
