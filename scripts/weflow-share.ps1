# Keep the window open while cloud agents use the connection.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\weflow-mcp.cmd') --share @args
exit $LASTEXITCODE
