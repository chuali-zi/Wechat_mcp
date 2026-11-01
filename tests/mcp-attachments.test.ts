import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { accountScope, messageId } from '../shared/chat/ids'
import { normalizeMessage } from '../shared/chat/normalize'
import { createTools } from '../mcp/tools'
import { readMedia } from '../mcp/media'
import { confinedFile, locateAttachment } from '../mcp/attachments'
import { decryptDatV4 } from '../shared/chat/imageDecrypt'

const scope = accountScope('media-fixture')
const sessionId = 'fixture-group@chatroom'
const context = { accountId: 'media-fixture', accountScope: scope, sessionId }
const row = (type: number, body: string) => ({ local_id: 1, server_id: '12345', create_time: 1790812800, local_type: type, message_content: body })
function dat(image: Buffer, version: number, key: Buffer, xor: number) {
  if (!version) return Buffer.from(image.map(b => b ^ xor))
  const prefix = 32
  const tail = Math.min(16, image.length - prefix)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([cipher.update(image.subarray(0, prefix)), cipher.final()])
  const header = Buffer.alloc(15)
  Buffer.from([7, 8, 0x56, 0x30 + version, 8, 7]).copy(header)
  header.writeUInt32LE(prefix, 6); header.writeUInt32LE(tail, 10)
  return Buffer.concat([header, encrypted, image.subarray(prefix, image.length - tail), Buffer.from(image.subarray(-tail).map(b => b ^ xor))])
}

test('XOR, V1 and V2 synthetic DAT: cache paths, inline, malformed headers and missing keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weflow-attachments-'))
  try {
    const image = await sharp({ create: { width: 20, height: 15, channels: 3, background: '#abcabc' } }).png().toBuffer()
    const imageRow = row(3, '<msg><img md5="0123456789abcdef0123456789abcdef"/></msg>')
    const id = messageId(scope, sessionId, imageRow)
    const path = join(root, 'image_t.dat')
    let keys = true
    const runtime = {
      timezone: 'UTC',
      getFreshness: async () => ({ mode: 'live', revision_start: 1, revision_end: 1 }),
      options: { userData: join(root, 'app-data') },
      ensureConnected: async () => ({ ...context, dataDir: root, mode: 'live' }),
      call: async (method: string) => {
        if (method === 'getMessageByLocator') return { success: true, row: imageRow }
        if (method === 'resolveImageHardlink') return { success: true, data: { full_path: path } }
        if (method === 'getCachedImageKeys') {
          if (!keys) throw Object.assign(new Error('key unavailable'), { code: 'IMAGE_KEY_REQUIRED' })
          return { success: true, aesKey: '0123456789abcdef', xorKey: 0x53, verified: true }
        }
        throw new Error(method)
      }
    }
    for (const version of [0, 1, 2]) {
      const key = Buffer.from(version === 1 ? 'cfcd208495d565ef' : '0123456789abcdef')
      const encrypted = dat(image, version, key, 0x53)
      await writeFile(path, encrypted)
      const fetched = await readMedia(runtime, id, { representation: 'file' })
      assert.equal(fetched.data.availability, 'available', `format ${version}`)
      assert.equal(fetched.data.variant, 'thumbnail')
      assert.ok(String(fetched.data.local_path).startsWith(runtime.options.userData))
      assert.deepEqual(await readFile(String(fetched.data.local_path)), image)
      assert.deepEqual(await readFile(path), encrypted, 'source remains unchanged')
      const inline = await readMedia(runtime, id, { representation: 'image', quality: 'original' })
      assert.equal(inline.content?.[0].mimeType, 'image/png')
      assert.deepEqual(Buffer.from(inline.content![0].data, 'base64'), image)
      if (version === 2) {
        keys = false
        assert.equal((await readMedia(runtime, id, { representation: 'file' })).data.availability, 'key_required')
        keys = true
        const broken = Buffer.from(encrypted); broken.writeUInt32LE(0x7fffffff, 6)
        assert.throws(() => decryptDatV4(broken, 0x53, key))
        await writeFile(path, broken)
        assert.equal((await readMedia(runtime, id, { representation: 'file' })).data.availability, 'decode_failed')
      }
    }
    // WeChat media can contain a wxgf payload, which sharp cannot
    // decode. Do not claim it is a JPEG or return an unusable cached file.
    const wxgf = Buffer.concat([Buffer.from('wxgf'), Buffer.alloc(60, 7)])
    await writeFile(path, dat(wxgf, 2, Buffer.from('0123456789abcdef'), 0x53))
    const unsupported = await readMedia(runtime, id, { representation: 'file' })
    assert.equal(unsupported.data.availability, 'decode_failed')
    assert.equal(unsupported.data.reason, 'unsupported_wxgf_image')
    assert.equal(unsupported.data.local_path, undefined)
    await writeFile(path, dat(image, 0, Buffer.alloc(16), 0x53))
    const tools = createTools(runtime as any)
    const fetched = await tools.call('get_attachment', { attachment_id: `att:${id}`, inline_image: true })
    assert.equal(fetched.structuredContent.success, true)
    assert.ok((fetched.structuredContent.data as any).local_path)
    assert.equal(fetched.content[1].type, 'image')
    const bad = await tools.call('get_attachment', { attachment_id: 'not-an-attachment' })
    assert.equal(bad.isError, true)
    const other = await tools.call('get_attachment', { attachment_id: `att:${messageId(accountScope('another-account'), sessionId, imageRow)}` })
    assert.equal((other.structuredContent.data as any).availability, 'unsupported')
    const changed = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#112233' } }).png().toBuffer()
    const priorPath = (fetched.structuredContent.data as any).local_path
    await writeFile(path, dat(changed, 0, Buffer.alloc(16), 0x53))
    const next = await tools.call('get_attachment', { attachment_id: `att:${id}` })
    assert.notEqual((next.structuredContent.data as any).local_path, priorPath)
    await rm(path)
    assert.equal((await readMedia(runtime, id, { representation: 'file' })).data.availability, 'not_downloaded', 'cache does not hide source deletion')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('group type-6 XML, renamed files, wrong hashes, missing downloads and traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weflow-files-'))
  try {
    const bytes = Buffer.from('test document')
    const md5 = createHash('md5').update(bytes).digest('hex')
    const fileRow = row(49, `sender:\n<msg><appmsg><title><![CDATA[Report & notes.pdf]]></title><type>6</type><appattach><totallen>${bytes.length}</totallen><fileext>pdf</fileext><md5>${md5}</md5></appattach></appmsg></msg>`)
    const normalized = normalizeMessage(fileRow, context)
    assert.equal(normalized.type, 'file')
    assert.equal(normalized.attachment?.name, 'Report & notes.pdf')
    assert.equal(normalized.attachment?.id, `att:${normalized.id}`)
    const dir = join(root, 'msg', 'file', normalized.sent_at.slice(0, 7))
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'Report & notes(1).pdf')
    await writeFile(path, bytes)
    assert.equal(await locateAttachment(root, normalized.attachment!, sessionId, normalized.sent_at), path)
    assert.equal(await locateAttachment(root, { ...normalized.attachment!, md5: '0'.repeat(32) }, sessionId, normalized.sent_at), undefined)
    const runtime = { ensureConnected: async () => ({ ...context, dataDir: root, mode: 'live' }), call: async () => ({ success: true, row: fileRow }) }
    const result = await readMedia(runtime, normalized.id, { representation: 'file' })
    assert.equal(result.data.local_path, path)
    await rm(path)
    assert.equal((await readMedia(runtime, normalized.id)).data.availability, 'not_downloaded')
    const outside = await mkdtemp(join(tmpdir(), 'weflow-outside-'))
    await writeFile(join(outside, 'Report & notes.pdf'), bytes)
    try {
      await rm(dir, { recursive: true })
      await symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir')
      assert.equal(await confinedFile(root, join(dir, 'Report & notes.pdf')), undefined)
      assert.equal(await locateAttachment(root, normalized.attachment!, sessionId, normalized.sent_at), undefined)
      assert.equal(await locateAttachment(root, { ...normalized.attachment!, name: '../../outside' }, sessionId, normalized.sent_at), undefined)
    } finally { await rm(outside, { recursive: true, force: true }) }
  } finally { await rm(root, { recursive: true, force: true }) }
})
