import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { QQTools, QQ_TOOL_DEFINITIONS, runQQ } from '../mcp/qq'

const root = mkdtempSync(join(tmpdir(), 'weflow-qq-test-'))
const python = process.env.WEFLOW_PYTHON || (process.platform === 'win32' ? resolve('.venv/Scripts/python.exe') : 'python3')
const config = join(root, 'qq-config.json')
const run = (script: string) => {
  const reply = spawnSync(python, ['-c', script, root], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('python') } })
  assert.equal(reply.status, 0, reply.stderr)
}

test('QQ mirrors register separately with read-only annotations and shared schemas', () => {
  assert.deepEqual(QQ_TOOL_DEFINITIONS.map(d => d.name), ['qq_get_status', 'qq_find_chats', 'qq_read_messages', 'qq_search_messages'])
  for (const definition of QQ_TOOL_DEFINITIONS) {
    assert.equal(definition.inputSchema.type, 'object')
    assert.equal(definition.outputSchema.type, 'object')
    assert.equal(definition.annotations.readOnlyHint, true)
  }
})

test('QQ actual worker handles fixtures, cursor isolation, reloads, cancellation and errors', async () => {
  const original = { python: process.env.WEFLOW_PYTHON, root: process.env.WEFLOW_BACKEND_ROOT, config: process.env.WEFLOW_QQ_CONFIG }
  process.env.WEFLOW_PYTHON = python
  process.env.WEFLOW_BACKEND_ROOT = resolve('python')
  process.env.WEFLOW_QQ_CONFIG = config
  run(`
import sqlite3, sys
from pathlib import Path
from qqhistory.reader import fields
root = Path(sys.argv[1])
def vi(n):
 b=bytearray()
 while n>127: b.append((n&127)|128); n>>=7
 return bytes(b+bytes([n]))
def f(n,v): return vi((n<<3)|2)+vi(len(v))+v
blob=f(40800, vi(45002<<3)+vi(1)+f(45101,'你好'.encode()))
db=sqlite3.connect(root/'nt_msg.db')
db.execute('CREATE TABLE c2c_msg_table ("40001" INTEGER, "40030" INTEGER, "40033" INTEGER, "40050" INTEGER, "40013" INTEGER, "40800" BLOB)')
for i in (1,2,9007199254740993): db.execute('INSERT INTO c2c_msg_table VALUES (?,456,456,1000,0,?)',(i,blob))
db.commit(); db.close()
`)
  writeFileSync(config, JSON.stringify({ db_dir: root, uin: '123' }))
  const tools = new QQTools(root, 'UTC')
  const call = async (name: string, args = {}) => (await tools.call(name, args)).structuredContent as any
  try {
    assert.equal((await call('qq_get_status')).success, true)
    const chats = await call('qq_find_chats')
    assert.equal(chats.data.chats[0].id, 'qq:123:private:456')
    const args = { chat_ids: ['qq:123:private:456'], range: { start: '1970-01-01T00:00:00Z', end: '1970-01-02T00:00:00Z' }, limit: 1 }
    const first = await call('qq_read_messages', args)
    assert.equal(first.data.messages[0].text, '你好')
    assert.equal(first.coverage.has_more, true)
    const search = await call('qq_search_messages', { query: { terms: ['你好'], fields: ['text'] }, range: args.range })
    assert.equal(search.data.hits.length, 3)
    assert.equal(search.data.hits[0].snippets[0].text, '你好')
    assert.equal(search.data.messages, undefined)
    const token = first.coverage.next_cursor
    const second = await call('qq_read_messages', { cursor: token })
    const replay = await call('qq_read_messages', { cursor: token })
    assert.deepEqual(second.data, replay.data)
    assert.equal(second.coverage.next_cursor, replay.coverage.next_cursor)
    assert.equal((await call('qq_search_messages', { cursor: token })).error.code, 'CURSOR_INVALID')
    assert.equal((await call('qq_read_messages', { cursor: token, limit: 1 })).error.code, 'INVALID_ARGUMENT')
    assert.equal((await call('qq_read_messages', { ...args, format: 'compact' })).error.code, 'QQ_OPTION_UNSUPPORTED')
    assert.equal((await call('qq_read_messages', { ...args, chat_ids: ['qq:999:private:456'] })).error.code, 'INVALID_CHAT_ID')
    run(`import sqlite3,sys; from pathlib import Path; db=sqlite3.connect(Path(sys.argv[1])/'nt_msg.db'); db.execute('UPDATE c2c_msg_table SET "40050"=1001'); db.commit(); db.close()`)
    assert.equal((await call('qq_read_messages', { cursor: token })).error.code, 'CURSOR_STALE')
    assert.equal((await call('qq_read_messages', args)).data.messages[0].sent_at, '1970-01-01T00:16:41.000Z')
    writeFileSync(config, JSON.stringify({ db_dir: root, uin: '999' }))
    assert.equal((await call('qq_get_status')).account.id, 'qq:999')
    const controller = new AbortController(); controller.abort()
    await assert.rejects(runQQ({}, controller.signal), { code: 'CANCELLED' })
    writeFileSync(config, '{bad')
    assert.equal((await call('qq_get_status')).error.code, 'QQ_CONFIG_INVALID')
  } finally {
    tools.close()
    for (const [key, value] of Object.entries({ WEFLOW_PYTHON: original.python, WEFLOW_BACKEND_ROOT: original.root, WEFLOW_QQ_CONFIG: original.config })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stdio server advertises and dispatches QQ tools without preparing WeChat', async () => {
  const { build } = await import('esbuild')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const directory = mkdtempSync(join(tmpdir(), 'weflow-qq-stdio-'))
  const entry = join(directory, 'server.cjs')
  await build({ entryPoints: [resolve('mcp/server.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['sharp', 'heic-decode'] })
  const client = new Client({ name: 'qq-fixture', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--user-data', directory],
    env: { ...process.env, WEFLOW_BACKEND_ROOT: resolve('python'), WEFLOW_PYTHON: python, WEFLOW_QQ_CONFIG: join(directory, 'missing.json') } as Record<string, string>, stderr: 'pipe' })
  try {
    await client.connect(transport)
    const listing = await client.listTools()
    assert.ok(listing.tools.some(t => t.name === 'read_messages'))
    for (const definition of QQ_TOOL_DEFINITIONS) assert.ok(listing.tools.some(t => t.name === definition.name))
    const result = await client.callTool({ name: 'qq_get_status', arguments: {} })
    assert.equal((result.structuredContent as any).error.code, 'QQ_CONFIG_INVALID')
    assert.equal(result.isError, true)
  } finally {
    await client.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
