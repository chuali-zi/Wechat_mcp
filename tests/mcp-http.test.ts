import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttp, profileToken, runRemote } from '../mcp/http'
import { TOOL_DEFINITIONS } from '../mcp/contracts'
import { QQ_TOOL_DEFINITIONS } from '../mcp/qq'

test('HTTP authenticates every request, lists the same tools and revokes rotated tokens', async (context) => {
  const userData = mkdtempSync(join(tmpdir(), 'weflow-http-'))
  const { Server } = await import('node:http')
  const listen = Server.prototype.listen
  let boundHost: unknown
  context.mock.method(Server.prototype, 'listen', function (this: InstanceType<typeof Server>, ...args: any[]) {
    boundHost = args[1]
    return Reflect.apply(listen, this, args)
  })
  context.after(() => assert.equal(boundHost, '127.0.0.1'))
  let http: Awaited<ReturnType<typeof startHttp>>
  try { http = await startHttp({ userData, timezone: 'UTC' }, 0) }
  catch (error: any) {
    rmSync(userData, { recursive: true, force: true })
    if (error.code === 'EPERM') { context.skip('Sandbox forbids listening sockets; request pipeline tested separately'); return }
    throw error
  }
  const url = new URL(`http://127.0.0.1:${http.port}/mcp`)
  const client = new Client({ name: 'http-test', version: '1' })
  try {
    for (const method of ['GET', 'POST', 'DELETE']) {
      for (const authorization of ['', 'Bearer wrong']) {
        assert.equal((await fetch(url, { method, headers: { authorization } })).status, 401)
      }
    }
    const token = profileToken(userData)
    assert.equal(readFileSync(join(userData, 'mcp-token'), 'utf8').trim(), token)
    assert.equal(profileToken(userData), token)
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(t => t.name), [...TOOL_DEFINITIONS, ...QQ_TOOL_DEFINITIONS].map(t => t.name))
    const result = await client.callTool({ name: 'get_status', arguments: {} })
    assert.ok(result)
    assert.notEqual(profileToken(userData, true), token)
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 401)
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${profileToken(userData)}` } })).status, 405)
  } finally {
    await client.close()
    await http.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

// Exercise the real HTTP handler and SDK without opening a listening socket.
test('HTTP request pipeline rejects bad credentials and returns tools with a valid credential', async () => {
  const { IncomingMessage, ServerResponse } = await import('node:http')
  const { Socket } = await import('node:net')
  const { Duplex } = await import('node:stream')
  const { once } = await import('node:events')
  const { createHttpHandler } = await import('../mcp/http')
  const userData = mkdtempSync(join(tmpdir(), 'weflow-handler-'))
  const token = profileToken(userData)
  const handler = createHttpHandler({ userData, timezone: 'UTC' })
  const request = async (authorization: string) => {
    const req = new IncomingMessage(new Socket())
    req.method = 'POST'
    req.url = '/mcp'
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    req.headers = { authorization, host: '127.0.0.1', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
    req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)])
    let output = ''
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { output += chunk.toString(); callback() } })
    const res = new ServerResponse(req)
    res.assignSocket(socket as any)
    const finished = once(res, 'finish')
    req.push(body)
    req.push(null)
    await handler(req, res)
    await finished
    socket.destroy()
    return { status: res.statusCode, output }
  }
  try {
    assert.equal((await request('')).status, 401)
    assert.equal((await request('Bearer wrong')).status, 401)
    const response = await request(`Bearer ${token}`)
    assert.equal(response.status, 200, response.output)
    for (const tool of [...TOOL_DEFINITIONS, ...QQ_TOOL_DEFINITIONS]) assert.ok(response.output.includes(`"name":"${tool.name}"`), tool.name)
    profileToken(userData, true)
    assert.equal((await request(`Bearer ${token}`)).status, 401)
  } finally { rmSync(userData, { recursive: true, force: true }) }
})


test('share refuses before parsing or side effects without explicit public exposure acknowledgement', async () => {
  for (const args of [
    ['--share'],
    ['--share', '--http', '--rotate-token'],
    ['--share', '--i-understand-public-exposure=false'],
    ['--share', '--port', 'invalid']
  ]) {
    let parsed = false
    await assert.rejects(runRemote(args, () => {
      parsed = true
      throw new Error('must not parse')
    }), /危险.*--i-understand-public-exposure.*URL.*令牌/)
    assert.equal(parsed, false)
  }
})

test('acknowledged share warns before startup and strips acknowledgement from runtime options', async () => {
  const warnings: string[] = []
  const stop = new Error('stop before file, network or process side effects')
  const { mock } = await import('node:test')
  const write = mock.method(process.stderr, 'write', (chunk: string) => { warnings.push(String(chunk)); return true })
  try {
    await assert.rejects(runRemote(['--share', '--i-understand-public-exposure', '--user-data', 'profile'], args => {
      assert.deepEqual(args, ['--user-data', 'profile'])
      assert.match(warnings.join(''), /⚠️ 危险.*不推荐.*URL.*令牌.*所有.*聊天/)
      throw stop
    }), error => error === stop)
  } finally { write.mock.restore() }
})
