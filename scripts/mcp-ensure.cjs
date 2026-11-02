const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'build', 'mcp', 'server.cjs');
const launcher = path.join(root, 'weflow-mcp.cmd');
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const result = { success: false, build: 'ready', python: fs.existsSync(python) ? 'ready' : 'missing', wechat: 'unknown', qq: 'unknown', clients: {}, action: '' };
if (!fs.existsSync(server)) {
  const build = spawnSync('cmd.exe', ['/d', '/c', 'npm.cmd', 'run', 'build:mcp'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 180000 });
  result.build = build.status === 0 && fs.existsSync(server) ? 'rebuilt' : 'failed';
}
const home = process.env.USERPROFILE || '';
for (const [name, file] of Object.entries({ codex: path.join(home, '.codex', 'config.toml'), claude_code: path.join(home, '.claude.json'), claude_desktop: path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json') })) {
  try { result.clients[name] = /weflow/i.test(fs.readFileSync(file, 'utf8')) ? 'configured' : 'not_detected'; } catch { result.clients[name] = 'not_detected'; }
}
if (result.build !== 'failed' && result.python === 'ready') {
  const probe = flag => {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'mcp.ps1'), flag, '--mode', 'live', '--user-data', path.join(process.env.APPDATA || '', 'WeFlow-full')], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 120000 });
    try { const data = JSON.parse(run.stdout.trim()); return data.success ? 'ready' : (data.error?.code || 'not_ready'); } catch { return run.error?.code || 'not_ready'; }
  };
  result.wechat = probe('--check');
  result.qq = probe('--qq-check');
}
result.success = result.build !== 'failed' && result.python === 'ready' && result.wechat === 'ready';
result.action = result.success ? 'Reconnect the MCP client and call get_status. QQ status is reported separately.' : 'Run weflow-mcp.cmd --check --mode live --user-data "%APPDATA%\\WeFlow-full"; prepare the local account with WeFlow if needed, then reconnect the client.';
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.success ? 0 : 1;
