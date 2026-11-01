import { spawn } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { TOOL_DEFINITIONS, argumentSchema, type ToolData } from './contracts'
import { validate } from './tools'
import type { CallToolResult } from './tools'

const mirrors = ['get_status', 'find_chats', 'read_messages', 'search_messages']
export const QQ_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(d => mirrors.includes(d.name)).map(d => ({
  ...d, name: `qq_${d.name}`, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, description: `QQ NT local history. ${d.description} QQ supports normalized text only; unknown/media elements are explicitly unresolved.`,
}))
const actions: Record<string, string> = { get_status: 'status', find_chats: 'find', read_messages: 'read', search_messages: 'search' }
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
type Reply = { success: boolean; code?: string; data: any; uin: string; revision: string; plain: boolean }

export function runQQ(request: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }))
  return new Promise((accept, reject) => {
    const captureRoot = mkdtempSync(join(tmpdir(), 'weflow-qq-worker-'))
    const root = process.env.WEFLOW_BACKEND_ROOT || resolve(__dirname, '../../python')
    const bundled = !process.env.WEFLOW_BACKEND_ROOT && [resolve(__dirname, '../backend/weflow-backend.exe'),
      join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '', 'backend/weflow-backend.exe')].find(p => existsSync(p))
    const executable = bundled || process.env.WEFLOW_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3')
    const child = spawn(executable, bundled ? ['--qq-reader'] : ['-m', 'qqhistory'], {
      cwd: bundled ? dirname(bundled) : root, env: { ...process.env, PYTHONPATH: root, PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = '', done = false
    const finish = (error?: string, value?: Reply) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (error) { child.kill(); reject(Object.assign(new Error(error), { code: error })) }
      else accept(value!)
    }
    const cancel = () => finish('CANCELLED')
    const timer = setTimeout(() => finish('QQ_READ_TIMEOUT'), 60_000)
    signal?.addEventListener('abort', cancel, { once: true })
    child.on('error', () => finish('QQ_PYTHON_UNAVAILABLE'))
    child.stdin.on('error', () => finish('QQ_BACKEND_EXITED'))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 24_000_000) finish('QQ_OUTPUT_TOO_LARGE') })
    // SQLCipher may include SQL in native stderr; never forward it or keys.
    child.stderr.resume()
    child.on('close', code => {
      // The parent owns temporary captures, including cancelled/killed workers.
      try { rmSync(captureRoot, { recursive: true, force: true, maxRetries: 3 }) } catch { /* OS may temporarily hold a file; no source path is ever removed. */ }
      if (code !== 0) return finish('QQ_BACKEND_EXITED')
      try { finish(undefined, JSON.parse(output)) } catch { finish('QQ_PROTOCOL_ERROR') }
    })
    child.stdin.end(JSON.stringify({ ...request, capture_root: captureRoot }))
  })
}

type State = { tool: string; args: Record<string, any>; revision: string; touched: number; next?: string }
export class QQTools {
  private cursors = new Map<string, State>()
  private shutdown = new AbortController()
  constructor(private userData: string, private timezone: string, private backend = runQQ) {}
  close() { this.shutdown.abort(); this.cursors.clear() }
  async call(name: string, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const queriedAt = new Date().toISOString()
    const output: ToolData = { schema_version: '1', success: false, account: null, timezone: this.timezone, data: {}, coverage: null,
      freshness: { mode: 'unconnected', queried_at: queriedAt, connection_id: null, revision_start: null, revision_end: null,
        snapshot_id: null, captured_at: null, consistency: 'unknown' }, warnings: [], error: null }
    try {
      const tool = name.replace(/^qq_/, '')
      const definition = QQ_TOOL_DEFINITIONS.find(d => d.name === name)
      if (!definition) fail('UNKNOWN_TOOL')
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_ARGUMENT')
      let args = input as Record<string, any>
      if (validate(args, argumentSchema(definition!.inputSchema, args))) fail('INVALID_ARGUMENT')
      let revision: string | undefined
      let resumed: State | undefined
      const now = Date.now()
      for (const [token, state] of this.cursors) if (now - state.touched > 600_000) this.cursors.delete(token)
      if (args.cursor) {
        const state = this.cursors.get(args.cursor)
        if (!state || state.tool !== tool) fail('CURSOR_INVALID')
        resumed = state
        state!.touched = now; args = { ...state!.args }; revision = state!.revision
      } else {
        args = { ...args }
        // Reject unsupported semantics instead of silently returning incomplete matches.
        if (args.after_message || args.mentions || args.format === 'compact' || args.query?.fields?.some((f: string) => f !== 'text')) fail('QQ_OPTION_UNSUPPORTED')
        const end = args.range ? Date.parse(args.range.end) : Date.now()
        const begin = args.range ? Date.parse(args.range.start) : end - 86_400_000
        if (!Number.isFinite(begin) || !Number.isFinite(end) || begin > end) fail('INVALID_RANGE')
        args._begin = Math.ceil(begin / 1000); args._end = Math.ceil(end / 1000)
        if (args.active_since) {
          args._active_since = Date.parse(args.active_since) / 1000
          if (!Number.isFinite(args._active_since)) fail('INVALID_ARGUMENT')
        }
      }
      const config = process.env.WEFLOW_QQ_CONFIG || join(this.userData, 'qq-config.json')
      const reply = await this.backend({ config, action: actions[tool], args, revision }, signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal)
      if (!reply.success) fail(reply.code || 'QQ_READ_FAILED')
      output.success = true; output.account = { id: `qq:${reply.uin}`, self_id: `qq:${reply.uin}:person:${reply.uin}` }
      output.freshness = { ...output.freshness, mode: 'live', connection_id: reply.revision, captured_at: queriedAt, consistency: 'per_database' }
      output.warnings = [{ code: 'QQ_LOCAL_HISTORY_ONLY', message: 'Only locally stored history. Media, quotes and unknown protobuf elements are unresolved; no complete roster or cloud history.' }]
      const { has_more: more, position, scanned, unresolved_elements_scanned: unresolved, ...data } = reply.data
      if (data.messages) data.messages = data.messages.map((m: any) => {
        const { timestamp, id, ...rest } = m
        return { ...rest, id, sent_at: new Date(timestamp * 1000).toISOString(), text_complete: true, text_part: null, content_status: m.parse_status, mentions: [], quote: null, attachment: null, system_event: null }
      })
      if (data.chats) data.chats = data.chats.map((c: any) => ({ ...c, display_name: c.name,
        last_activity: new Date(c.last_active * 1000).toISOString(), has_local_messages: true }))
      if (tool === 'search_messages') {
        data.hits = data.messages.map((m: any) => ({ message_id: m.id, chat_id: m.chat_id, sender_id: m.sender_id,
          sent_at: m.sent_at, type: m.type, matched_fields: ['text'],
          matched_terms: args.query.terms.filter((term: string) => m.text.toLocaleLowerCase().includes(term.toLocaleLowerCase())),
          snippets: [{ field: 'text', text: m.text, offset: null }], context_anchor: m.id }))
      }
      output.data = data
      if (tool !== 'get_status') {
        let next: string | null = null
        if (more) {
          if (!resumed?.next && this.cursors.size >= 256) fail('QQ_CURSOR_LIMIT')
          next = resumed?.next || randomBytes(24).toString('base64url')
          if (resumed) resumed.next = next
          this.cursors.set(next, { tool, revision: reply.revision, touched: now,
            args: { ...args, ...(tool === 'find_chats' ? { _offset: position } : { _position: position }) } })
        }
        output.coverage = { requested_scope: { chat_ids: args.chat_ids, range: args.range || { start: new Date(args._begin * 1000).toISOString(), end: new Date(args._end * 1000).toISOString() } },
          progress: [{ scanned: scanned || 0 }], scope_progress: { selected_chats: args.chat_ids?.length || 0, completed_chats: more ? 0 : args.chat_ids?.length || 0, remaining_chats: more ? args.chat_ids?.length || 0 : 0 },
          scan_complete: !more, returned_count: (data.messages || data.chats || []).length, has_more: !!more, next_cursor: next,
          truncated: !!more, omissions: [], unresolved_content: { elements: unresolved || 0 } }
      }
      // Search mirrors the WeChat hit shape; source messages are available through read_messages.
      if (tool === 'search_messages') delete data.messages
      if (args.max_chars && Array.from(JSON.stringify(output)).length > args.max_chars) fail('OUTPUT_BUDGET_TOO_SMALL')
    } catch (error: any) {
      output.success = false; output.data = {}; output.coverage = null
      const code = error?.code || 'QQ_READ_FAILED'
      output.error = { code, message: code, retryable: ['QQ_SOURCE_BUSY', 'QQ_READ_TIMEOUT'].includes(code),
        action: code.startsWith('CURSOR_') ? 'Repeat the original query without cursor.' : 'Check qq-config.json, local QQ login and matching password; run the QQ diagnostic. No key or message contents are included in diagnostics.' }
    }
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output as unknown as Record<string, unknown>, ...(output.success ? {} : { isError: true }) }
  }
}
