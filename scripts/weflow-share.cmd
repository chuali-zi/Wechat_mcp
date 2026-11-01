@echo off
call "%~dp0..\weflow-mcp.cmd" --share %*
exit /b %errorlevel%
