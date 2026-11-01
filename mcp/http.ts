import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer, createMcpResources } from './service'
import type { RuntimeOptions } from './runtime'

export function profileToken(profile: string, rotate = false): string {
  mkdirSync(profile, { recursive: true })
  const file = join(profile, 'mcp-token')
  if (!rotate) {
    try {
      const token = readFileSync(file, 'utf8').trim()
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid token file')
      return token
    } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  const token = randomBytes(32).toString('hex')
  if (rotate) {
    const temporary = file + '.' + randomBytes(8).toString('hex')
    writeFileSync(temporary, token + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } else {
    try { writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' }) }
    catch (error: any) { if (error.code === 'EEXIST') return profileToken(profile); throw error }
  }
  return token
}

export async function startHttp(options: RuntimeOptions, port = 8765) {
  profileToken(options.userData)
  const active = new Set<ReturnType<typeof createMcpServer>>()
  const resources = createMcpResources(options)
  const http = createServer(createHttpHandler(options, active, resources))
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve) })
  } catch (error) { await resources.close(); throw error }
  return {
    port: (http.address() as { port: number }).port,
    close: async () => {
      http.closeAllConnections()
      await Promise.all([...active].map(instance => instance.close()))
      await resources.close()
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
    }
  }
}

export function createHttpHandler(options: RuntimeOptions, active = new Set<ReturnType<typeof createMcpServer>>(), resources?: ReturnType<typeof createMcpResources>) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    // Re-read on every request so rotation revokes access even in an existing process.
    let authorized = false
    try {
      const expected = Buffer.from('Bearer ' + profileToken(options.userData))
      const actual = Buffer.from(req.headers.authorization || '')
      authorized = actual.length === expected.length && timingSafeEqual(actual, expected)
    } catch { /* fail closed */ }
    if (!authorized) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }); res.end(); return }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
    const instance = createMcpServer(options, true, resources)
    active.add(instance)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => { active.delete(instance); void instance.close() })
    try {
      await instance.server.connect(transport)
      await transport.handleRequest(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
      await instance.close()
    }
  }
}

async function cloudflared(profile: string) {
  if (process.platform !== 'win32') return 'cloudflared'
  const directory = join(profile, 'tools')
  const executable = join(directory, 'cloudflared.exe')
  try { if (!statSync(executable).isFile()) throw new Error('Invalid cloudflared path'); return executable } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  mkdirSync(directory, { recursive: true })
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error('cloudflared download failed')
  const temporary = executable + '.' + randomBytes(8).toString('hex')
  writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
  renameSync(temporary, executable)
  return executable
}

export async function runRemote(args: string[], parse: (args: string[]) => RuntimeOptions) {
  if (args.includes('--share')) {
    if (!args.includes('--i-understand-public-exposure')) {
      const message = '危险：--share 不推荐使用；必须同时传入 --i-understand-public-exposure。任何持有 URL 和令牌的人都能读取所有可访问的微信 / QQ 聊天。请优先通过远程 shell 调用本机 stdio MCP。'
      process.stderr.write(message + '\n')
      throw new Error(message)
    }
    process.stderr.write('⚠️ 危险：正在启用公网分享（不推荐，仅限最后手段）。任何持有 URL 和令牌的人都能读取所有可访问的微信 / QQ 聊天。可运行本机命令的云端 Agent 禁止使用此模式，应通过远程 shell 调用本机 stdio MCP。\n')
  }
  const remaining: string[] = []
  let portValue = process.env.WEFLOW_MCP_PORT || '8765'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { portValue = args[++i]; continue }
    if (!['--http', '--share', '--rotate-token', '--i-understand-public-exposure'].includes(args[i])) remaining.push(args[i])
  }
  const port = Number(portValue)
  if (!/^\d+$/.test(portValue || '') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
  const options = parse(remaining)
  const token = profileToken(options.userData, args.includes('--rotate-token'))
  if (args.includes('--rotate-token')) {
    // A saved connection block contains the revoked credential.
    writeFileSync(join(options.userData, 'mcp-connection.txt'), '令牌已轮换；请重新运行 --share 生成连接块。\n', { mode: 0o600 })
    process.stderr.write('MCP 令牌已轮换。\n')
    if (!args.includes('--http') && !args.includes('--share')) return
  }
  const executable = args.includes('--share') ? await cloudflared(options.userData) : undefined
  const http = await startHttp(options, port)
  process.stderr.write(`MCP http://127.0.0.1:${http.port}/mcp token ${token.slice(0, 4)}…${token.slice(-4)}\n`)
  let child: ReturnType<typeof spawn> | undefined
  let closing = false
  const close = async () => { if (closing) return; closing = true; child?.kill(); await http.close() }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
  if (executable) {
    child = spawn(executable, ['tunnel', '--url', `http://127.0.0.1:${http.port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', published = false
    const parseOutput = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192)
      const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0]
      if (!url || published) return
      published = true
      const block = `URL: ${url}/mcp\nAuthorization: Bearer ${token}\n\nGrok Bot：复制以下指令添加服务器：\nadd MCP server named weflow with url ${url}/mcp and header Authorization: Bearer ${token}\n`
      writeFileSync(join(options.userData, 'mcp-connection.txt'), block, { mode: 0o600 })
      process.stdout.write(block)
    }
    child.stdout?.on('data', parseOutput)
    child.stderr?.on('data', parseOutput)
    const timer = setTimeout(() => { process.stderr.write('未获得隧道 URL，请检查 cloudflared 网络连接。\n'); process.exitCode = 1; void close() }, 60000)
    timer.unref()
    child.on('error', () => { clearTimeout(timer); process.stderr.write('cloudflared 启动失败，请检查可执行文件或 PATH。\n'); process.exitCode = 1; void close() })
    child.on('exit', () => { clearTimeout(timer); if (!closing) { process.exitCode = 1; void close() } })
    const clearWhenPublished = () => { if (published) clearTimeout(timer) }
    child.stdout?.on('data', clearWhenPublished)
    child.stderr?.on('data', clearWhenPublished)
  }
}
