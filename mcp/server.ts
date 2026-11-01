import { createMcpServer } from './service'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defaultUserData, type RuntimeOptions } from './runtime'
import { QQTools } from './qq'
import { resolve, join } from 'node:path'
import { checkServer } from './check'
import { buildMcpLaunch } from '../shared/mcpLaunch'

function parseOptions(argv: string[]): RuntimeOptions {
  const options: RuntimeOptions = { userData: defaultUserData() }
  const names: Record<string, keyof RuntimeOptions> = { '--user-data': 'userData', '--data-dir': 'dataDir', '--mode': 'mode', '--timezone': 'timezone', '--resources-path': 'resourcesPath' }
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]]
    const value = argv[++i]
    if (!key || !value || value.startsWith('--')) throw new Error('参数格式无效。使用 --user-data DIR、--data-dir DIR、--mode live|snapshot 或 --timezone IANA。')
    if (key === 'mode' && value !== 'live' && value !== 'snapshot') throw new Error('--mode 必须是 live 或 snapshot。')
    ;(options as Record<string, unknown>)[key] = value
  }
  return options
}

function launchConfig(options: RuntimeOptions) {
  const source = Boolean(process.env.WEFLOW_BACKEND_ROOT)
  return buildMcpLaunch({ executable: process.execPath, serverPath: join(__dirname, 'server.cjs'),
    userData: options.userData, dataDir: options.dataDir, mode: options.mode, timezone: options.timezone,
    sourceRoot: source ? resolve(__dirname, '..', '..') : undefined,
    resourcesPath: options.resourcesPath || (!source ? resolve(__dirname, '..') : undefined) })
}

export async function startServer(options: RuntimeOptions): Promise<void> {
  const { server, close } = createMcpServer(options)
  process.stdin.once('end', () => { void close() })
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (require.main === module) {
  if (process.argv.includes('--help')) {
    process.stderr.write('WeFlow MCP: weflow-mcp.cmd [--user-data DIR] [--data-dir DIR] [--mode live|snapshot] [--timezone IANA]\n--http 本机 HTTP /mcp（--port 或 WEFLOW_MCP_PORT，默认 8765）。\n--share 危险、不推荐，仅限最后手段；必须同时传入 --i-understand-public-exposure。任何持有 URL 和令牌的人都能读取所有可访问的聊天。\n--rotate-token 撤销旧令牌（下一次请求生效）。\n--qq-check 检查 QQ 配置与只读数据库连接（不输出消息或密钥）。\n--print-config 输出可复制的客户端配置。\n--check 使用临时 stdio 客户端验证握手和数据读取，输出 JSON 并退出。\n先用 WeFlow prepare 准备账号；MCP 不自动获取密钥或创建副本。\n')
  } else if (process.argv.some(arg => ['--http', '--share', '--rotate-token'].includes(arg))) {
    void import('./http').then(({ runRemote }) => runRemote(process.argv.slice(2), parseOptions)).catch(() => {
      process.stderr.write('HTTP MCP 启动失败，请检查参数、端口及 cloudflared。\n'); process.exitCode = 1
    })
  } else if (process.argv.includes('--qq-check')) {
    const args = process.argv.slice(2).filter(value => value !== '--qq-check')
    const options = parseOptions(args)
    const qq = new QQTools(options.userData, options.timezone || 'UTC')
    void qq.call('qq_get_status', {}).then(result => {
      process.stdout.write(JSON.stringify(result.structuredContent) + '\n')
      process.exitCode = result.isError ? 1 : 0
      qq.close()
    })
  } else if (process.argv.includes('--check')) {
    const args = process.argv.slice(2).filter(value => value !== '--check')
    void Promise.resolve().then(() => checkServer(launchConfig(parseOptions(args)))).then(result => {
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exitCode = result.success ? 0 : 1
    }).catch(() => { process.stderr.write('MCP 检查未能完成。\n'); process.exitCode = 1 })
  } else if (process.argv.includes('--print-config')) {
    const args = process.argv.slice(2).filter(value => value !== '--print-config')
    const options = parseOptions(args)
    const config = launchConfig(options)
    process.stdout.write(JSON.stringify({ mcpServers: { weflow: config } }, null, 2) + '\n')
  } else {
    void startServer(parseOptions(process.argv.slice(2))).catch(() => {
      process.stderr.write('WeFlow MCP 启动失败，请检查参数、运行环境和 build:mcp 输出。\n')
      process.exitCode = 1
    })
  }
}
