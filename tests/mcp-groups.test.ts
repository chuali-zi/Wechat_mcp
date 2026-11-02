import assert from 'node:assert/strict'
import test from 'node:test'
import { accountScope, chatId, personId } from '../shared/chat/ids'
import { clearCursors, findChats, getChatOverview, getGroupMembers, getMessageContext, readMessages } from '../mcp/query'
import { createTools } from '../mcp/tools'

const scope = accountScope('wxid_me')
const chat = chatId(scope, 'room@chatroom')
function runtime() {
  let revision = 1
  const members = [
    { username: 'wxid_me', nickname: '自己', remark: '私人备注', groupNickname: '', groupNicknameState: 'not_set' },
    { username: 'wxid_quiet', nickname: '小张', remark: '', groupNickname: '2026001 张同学', groupNicknameState: 'set' },
    { username: 'wxid_unknown', nickname: '', remark: '', groupNickname: null, groupNicknameState: 'unknown' },
  ]
  return {
    timezone: 'UTC', options: {},
    ensureConnected: async () => ({ accountId: 'wxid_me', accountScope: scope, dataDir: 'fixture', mode: 'live' as const }),
    getFreshness: async () => ({ mode: 'live' as const, queried_at: '2026-10-24T12:00:00Z', connection_id: 'fixture', revision_start: revision, revision_end: revision, snapshot_id: null, captured_at: null, consistency: 'per_database' as const }),
    getStatus: async () => ({}), close: async () => {},
    call: async (method: string) => { assert.equal(method, 'getGroupMembers'); return { success: true, members } },
    change: () => { revision++ },
  }
}

test('group roster pages preserve names, unknowns, full-group counts and replay', async () => {
  clearCursors()
  const r = runtime()
  const first = await getGroupMembers(r, { chat_id: chat, limit: 1 })
  assert.deepEqual(first.data.summary, { total: 3, set: 1, not_set: 1, unknown: 1 })
  assert.equal(first.data.matched_count, 3)
  assert.deepEqual((first.data.members as any[])[0], {
    person_id: personId(scope, 'wxid_me'), nickname: '自己', contact_remark: '私人备注',
    group_nickname: '', group_nickname_status: 'not_set', is_self: true,
  })
  const args = { cursor: first.coverage!.next_cursor }
  for (const other of [findChats, getChatOverview, getMessageContext, readMessages]) {
    await assert.rejects(other(r, args), { code: 'INVALID_ARGUMENT' })
  }
  const next = await getGroupMembers(r, args)
  assert.deepEqual(await getGroupMembers(r, args), next)
  assert.equal((next.data.members as any[])[0].group_nickname, '2026001 张同学')
  const last = await getGroupMembers(r, { cursor: next.coverage!.next_cursor })
  assert.equal(last.coverage!.has_more, false)
  assert.equal((last.data.members as any[])[0].group_nickname, null)
  r.change()
  await assert.rejects(getGroupMembers(r, args), { code: 'CURSOR_STALE' })
})

test('group nickname filtering retains full summary and rejects invalid scopes', async () => {
  const r = runtime()
  const filtered = await getGroupMembers(r, { chat_id: chat, nickname_status: 'not_set' })
  assert.equal((filtered.data.members as any[]).length, 1)
  assert.equal(filtered.data.matched_count, 1)
  assert.equal((filtered.data.summary as any).total, 3)
  await assert.rejects(getGroupMembers(r, { chat_id: chatId(scope, 'wxid_peer') }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(getGroupMembers(r, { chat_id: chatId(accountScope('other'), 'room@chatroom') }))
  await assert.rejects(getGroupMembers(r, { cursor: 'token', chat_id: chat }), { code: 'INVALID_ARGUMENT' })
  const tools = createTools(r as any)
  try {
    for (const args of [{}, { chat_id: chat, nickname_status: 'changed' }, { chat_id: chat, limit: 0 }]) {
      const reply = await tools.call('get_group_members', args)
      assert.equal((reply.structuredContent.error as any).code, 'INVALID_ARGUMENT')
    }
  } finally { await tools.close() }
})

test('chat time sorting, filtering and cursor retain observed provenance', async () => {
  clearCursors()
  const r = runtime()
  r.call = async (method: string) => {
    if (method === 'getContactsCompact') return { contacts: [
      { username: 'a@chatroom', nick_name: 'topic' }, { username: 'b@chatroom', nick_name: 'topic' }, { username: 'c@chatroom', nick_name: 'topic' },
    ] } as any
    if (method === 'getSessions') return { sessions: [
      { username: 'a@chatroom', last_timestamp: 300, first_timestamp: 100 },
      { username: 'b@chatroom', last_timestamp: 200, first_timestamp: 150 },
    ] } as any
    throw new Error('unexpected method')
  }
  const first = await findChats(r, { kind: 'group', sort: 'created_at', limit: 1 })
  const item = (first.data.chats as any[])[0]
  assert.equal(item.id, chatId(scope, 'b@chatroom'))
  assert.equal(item.created_at, null)
  assert.equal(item.first_seen_at, new Date(150000).toISOString())
  assert.equal(item.first_seen_source, 'earliest_local_message')
  assert.equal(item.last_active_at, new Date(200000).toISOString())
  const second = await findChats(r, { cursor: first.coverage!.next_cursor })
  assert.equal((second.data.chats as any[])[0].id, chatId(scope, 'a@chatroom'))
  const filtered = await findChats(r, { created_since: new Date(120000).toISOString() })
  assert.equal((filtered.data.chats as any[]).length, 1)
})

test('group metadata, person filters and explicit creation evidence', async () => {
  clearCursors()
  const r = runtime()
  r.call = async (method: string, payload?: any) => {
    if (method === 'getContactsCompact') return { contacts: [
      { username: 'a@chatroom', nick_name: 'topic' }, { username: 'b@chatroom', nick_name: 'topic' },
      { username: 'wxid_quiet', nick_name: 'Alice', local_type: 1 },
    ] } as any
    if (method === 'getSessions') return { sessions: [
      { username: 'a@chatroom', first_timestamp: 100, last_timestamp: 300 },
      { username: 'b@chatroom', first_timestamp: 200, last_timestamp: 300 },
    ] } as any
    if (method === 'execQuery') return { success: true, rows: [{ username: 'a@chatroom', room_owner: 'wxid_quiet', create_time: 250, member_count: 3 }] } as any
    if (method === 'getChatCreationEvidence') return { success: true, entries: { 'a@chatroom': { firstAt: 100 }, 'b@chatroom': { firstAt: 200, createdAt: 220 } }, remaining: 0 } as any
    if (method === 'getGroupMembers') return { success: true, members: payload.chatroomId === 'a@chatroom' ? [{ username: 'wxid_quiet' }] : [] } as any
    if (method === 'openMessageCursor') return { success: true, cursor: 42 } as any
    if (method === 'fetchMessageBatch') return { success: true, rows: [{ local_id: 1, server_id: '1', local_type: 10000, create_time: 220, message_content: '你创建了群聊' }] } as any
    if (method === 'closeMessageCursor') return { success: true } as any
    throw new Error('unexpected method')
  }
  const all = (await findChats(r, { kind: 'group', sort: 'created_at' })).data.chats as any[]
  assert.equal(all[0].created_at, new Date(250000).toISOString())
  assert.equal(all[0].owner_id, personId(scope, 'wxid_quiet'))
  assert.equal(all[0].member_count, 3)
  assert.equal(all[1].created_source, 'system_message_creation')
  assert.equal(all[1].created_by, personId(scope, 'wxid_me'))
  assert.equal(((await findChats(r, { owner: 'Alice', member: personId(scope, 'wxid_quiet') })).data.chats as any[]).length, 1)
  assert.equal(((await findChats(r, { creator: personId(scope, 'wxid_me'), created_since: new Date(210000).toISOString() })).data.chats as any[]).length, 1)
})


test('default discovery skips evidence and incomplete evidence survives cursor pages', async () => {
  clearCursors()
  const r = runtime()
  let evidenceCalls = 0
  r.call = async (method: string) => {
    if (method === 'getContactsCompact') return { contacts: [
      { username: 'a@chatroom' }, { username: 'b@chatroom' }, { username: 'c@chatroom' },
    ] } as any
    if (method === 'getSessions') return { sessions: [{ username: 'a@chatroom', last_timestamp: 300 }] } as any
    if (method === 'execQuery') return { rows: [{ username: 'a@chatroom', member_count: 4 }] } as any
    if (method === 'getChatCreationEvidence') { evidenceCalls++; return { entries: { 'a@chatroom': { firstAt: 100 } }, remaining: 2 } as any }
    throw new Error('unexpected expensive call')
  }
  const normal = await findChats(r, { limit: 1 })
  assert.equal(evidenceCalls, 0)
  assert.equal((normal.data.chats as any[])[0].member_count, 4)
  const partial = await findChats(r, { sort: 'created_at', limit: 1 })
  assert.equal(evidenceCalls, 1)
  assert.equal(partial.coverage!.scan_complete, false)
  assert.equal(partial.coverage!.scope_progress.remaining_chats, 2)
  assert.equal(partial.warnings.some((w: any) => w.code === 'CREATION_EVIDENCE_INCOMPLETE'), true)
  const next = await findChats(r, { cursor: partial.coverage!.next_cursor })
  assert.equal(next.coverage!.scan_complete, false)
  assert.equal(next.coverage!.scope_progress.remaining_chats, 2)
})
