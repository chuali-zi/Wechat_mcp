const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = [process.env.WEFLOW_PYTHON, path.join(root, '.venv/Scripts/python.exe'),
  path.join(root, '.runtime/python/python.exe'), path.join(root, '.venv/bin/python')].find(p => p && existsSync(p));
if (!python) throw new Error('Prepare the project Python environment or set WEFLOW_PYTHON.');
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_qqhistory.py', '-v'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONPATH: path.join(root, 'python') } });
process.exitCode = result.status ?? 1;
