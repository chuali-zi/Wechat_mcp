import type { NormalizedMessage } from '../shared/chat/normalize'
import { createHash, randomUUID } from 'crypto'
import { accountRoot, confinedFile, locateAttachment } from './attachments'
import { readFile, stat, mkdir, writeFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import sharp from 'sharp'
import { decodeMessageId } from '../shared/chat/ids'
import { mapRowsToMessagesLite } from '../shared/chat/decode'
import { normalizeMessage } from '../shared/chat/normalize'
import { decryptDatV3, decryptDatV4, datVersion } from '../shared/chat/imageDecrypt'
import { wxgfToJpeg } from './wxgf'
import { heicToJpeg, isHeic } from './lib/heicDecoder'

type Locator = ReturnType<typeof decodeMessageId>
type Runtime = {
  options?: { userData: string }
  ensureConnected(signal?: AbortSignal): Promise<{ accountId: string; accountScope: string; dataDir: string; mode: string; capturedAt?: string | null; snapshotId?: string | null }>
  call(method: string, payload?: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<any>
  resourcesPath?: string
}
type Args = { representation?: 'metadata' | 'image' | 'text' | 'file'; quality?: 'preview' | 'original' }
type ImageBlock = { type: 'image'; data: string; mimeType: string }
type MediaResult = { data: Record<string, unknown>; content?: ImageBlock[] }

const b64 = (data: Buffer): string => data.toString('base64')
const asRecord = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const imageMd5 = (source: string): string | undefined => {
  const m = /(?:md5|imgmd5|origmd5)\s*=\s*["']?([a-f\d]{32})/i.exec(source) || /<md5>([a-f\d]{32})<\/md5>/i.exec(source)
  return m?.[1]?.toLowerCase()
}

function result(messageId: string, kind: string, availability: string, reason?: string, representation: string = 'metadata'): MediaResult {
  return { data: { message_id: messageId, kind, availability, representation, source: 'local', ...(reason && { reason }) } }
}

async function getRow(runtime: Runtime, locator: Locator, signal?: AbortSignal): Promise<Record<string, any> | null> {
  const response = await runtime.call('getMessageByLocator', { sessionId: locator.sessionId, locator: locator.locator }, signal)
  if (response?.success === false) return null
  if (response?.message === null || response?.row === null || response?.data?.message === null || response?.data?.row === null) return null
  const data = asRecord(response?.data ?? response)
  const candidate = data.row ?? data.message ?? (typeof data.server_id === 'string' || typeof data.local_id === 'string' ? data : null)
  return candidate && typeof candidate === 'object' && Object.keys(candidate).length ? candidate : null
}

function findPath(value: unknown): string | undefined {
  const data = asRecord(value)
  for (const field of ['path', 'full_path', 'file_path', 'filePath', 'local_path', 'localPath', 'image_path', 'imagePath']) {
    const candidate = data[field]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

async function resolveHardlink(runtime: Runtime, md5: string, accountDir: string, signal?: AbortSignal): Promise<any | null> {
  try {
    return await runtime.call('resolveImageHardlink', { md5, accountDir }, signal)
  } catch (caught) {
    const error = caught as Error & { code?: string }
    if (error.code === 'CANCELLED' || error.code === 'PROFILE_LOCKED' || error.code === 'PROFILE_CONFIG_INVALID') throw caught
    if (/尚未下载到本机|没有图片附件索引|image.*not.*download/i.test(error.message)) return null
    throw caught
  }
}

async function imageData(runtime: Runtime, body: string, accountDir: string, signal?: AbortSignal, resolvedPath?: string): Promise<{ buffer: Buffer; mime: string; transformed: boolean } | { availability: string; reason: string }> {
  const md5 = imageMd5(body)
  if (!md5) return { availability: 'not_downloaded', reason: 'image_locator_missing' }
  const linkResponse = resolvedPath ? null : await resolveHardlink(runtime, md5, accountDir, signal)
  const filePath = resolvedPath || findPath(linkResponse?.data ?? linkResponse)
  if (!filePath) return { availability: 'not_downloaded', reason: 'local_image_missing' }
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) return { availability: 'not_downloaded', reason: 'local_image_missing' }
  if (fileStat.size > 64 * 1024 * 1024) return { availability: 'too_large', reason: 'source_exceeds_processing_limit' }
  let data: Buffer = await readFile(filePath)
  if (!/\.(?:jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(filePath)) {
    const version = datVersion(data)
    let xorKey = 0
    let aesKey = ''
    if (version === 2) {
      let response: any
      try { response = await runtime.call('getCachedImageKeys', { accountDir }, signal) } catch (error: any) {
        if (error.code === 'IMAGE_KEY_REQUIRED') return { availability: 'key_required', reason: 'IMAGE_KEY_REQUIRED' }
        throw error
      }
      const keys = asRecord(response?.data ?? response)
      if (response?.success === false || keys.verified === false || (keys.xorKey ?? keys.xor_key) == null) return { availability: 'key_required', reason: 'IMAGE_KEY_REQUIRED' }
      xorKey = Number(keys.xorKey ?? keys.xor_key)
      aesKey = String(keys.aesKey ?? keys.aes_key ?? '')
    }
    let decoded: Buffer | undefined
    try {
      if (version === 1 || version === 2) {
        const key = version === 1 ? Buffer.from('cfcd208495d565ef', 'ascii') : Buffer.from(aesKey, 'ascii').subarray(0, 16)
        if (version === 1 && data.readUInt32LE(10) === 1) return { availability: 'decode_failed', reason: 'xor_key_unverified' }
        if (version === 1 && data.readUInt32LE(10) >= 2) {
          const tails = [[0xff, 0xd9], [0x60, 0x82], [0, 0x3b]]
          const tail = tails.find(([a, b]) => (data[data.length - 2] ^ a) === (data[data.length - 1] ^ b))
          if (!tail) return { availability: 'decode_failed', reason: 'xor_key_unverified' }
          xorKey = data[data.length - 2] ^ tail[0]
        }
        decoded = decryptDatV4(data, xorKey, key)
      } else {
        for (const magic of [Buffer.from([255,216,255]), Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('GIF8'), Buffer.from('RIFF'), Buffer.from('BM')]) {
          const key = data[0] ^ magic[0]
          if (magic.every((byte, index) => (data[index] ^ key) === byte)) { decoded = decryptDatV3(data, key); break }
        }
      }
    } catch { return { availability: 'decode_failed', reason: 'image_decryption_failed' } }
    if (!decoded) return { availability: 'decode_failed', reason: 'unsupported_image_data' }
    data = decoded
  }
  let transformed = false
  if (data.subarray(0, 4).toString('ascii') === 'wxgf') {
    try { data = await wxgfToJpeg(data, runtime.resourcesPath, signal); transformed = true }
    catch (error) { if (signal?.aborted) throw error; return { availability: 'decode_failed', reason: 'wxgf_conversion_failed' } }
  }
  let mime = data.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg'
    : data.toString('ascii', 1, 4) === 'PNG' ? 'image/png'
      : data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : data.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : data.toString('ascii', 0, 2) === 'BM' ? 'image/bmp' : isHeic(data) ? 'image/heic' : ''
  if (!mime) return { availability: 'decode_failed', reason: 'unsupported_image_data' }
  if (isHeic(data)) {
    try {
      const workerPath = runtime.resourcesPath ? join(runtime.resourcesPath, 'mcp', 'heicDecodeWorker.cjs') : undefined
      data = await heicToJpeg(data, { workerPath, signal })
      mime = 'image/jpeg'
      transformed = true
    } catch (caught) {
      const error = caught as Error & { code?: string }
      if (signal?.aborted || error.code === 'CANCELLED') throw caught
      return { availability: 'decode_failed', reason: 'heic_conversion_failed' }
    }
  }
  return { buffer: data, mime, transformed }
}

export async function resolveLocalAttachment(runtime: Runtime, normalized: NormalizedMessage, sessionId: string, accountDir: string, signal?: AbortSignal) {
  accountDir = accountRoot(accountDir)
  let filePath: string | undefined
  if (normalized.type === 'image' && normalized.attachment?.md5) {
    const link = await resolveHardlink(runtime, normalized.attachment!.md5!, accountDir, signal)
    const candidate = findPath(link?.data ?? link)
    if (candidate) filePath = await confinedFile(accountDir, candidate)
  }
  if (!filePath && normalized.attachment && ['image', 'file'].includes(normalized.type)) filePath = await locateAttachment(accountDir, normalized.attachment, sessionId, normalized.sent_at, signal)
  const variant = filePath ? (/_t\.dat$/i.test(filePath) ? 'thumbnail' : /_h\.dat$/i.test(filePath) ? 'original' : 'standard') : 'unknown'
  return { filePath, variant }
}

export async function readMedia(runtime: Runtime, messageId: string, args: Args = {}, signal?: AbortSignal): Promise<MediaResult> {
  const representation = args.representation ?? 'metadata'
  const connected = await runtime.ensureConnected(signal)
  let locator: Locator
  try { locator = decodeMessageId(messageId, connected.accountScope) } catch {
    return result(messageId, 'other', 'unsupported', 'invalid_message_id', representation)
  }
  const row = await getRow(runtime, locator, signal)
  if (!row) return result(messageId, 'other', 'unsupported', 'message_not_found', representation)
  const normalized = normalizeMessage(row, { accountId: connected.accountId, accountScope: connected.accountScope, sessionId: locator.sessionId })
  const body = String(mapRowsToMessagesLite([row], connected.accountId)[0]?.content ?? row.message_content ?? row.compress_content ?? '')
  const kind = normalized.type
  if (representation === 'text') return { data: { message_id: messageId, kind, availability: 'unsupported', representation, source: 'local', reason: kind === 'voice' ? 'no_verified_transcript_available' : 'no_verified_text_representation' } }
  const accountDir = accountRoot(String(row._account_dir ?? row.account_dir ?? connected.dataDir))
  const { filePath, variant } = await resolveLocalAttachment(runtime, normalized, locator.sessionId, accountDir, signal)
  const metadata = { ...normalized.attachment, message_id: messageId, kind, availability: filePath ? 'available' : 'not_downloaded', downloaded: !!filePath, variant, representation, source: 'local' }
  if (!['image', 'file'].includes(kind)) return result(messageId, kind, 'unsupported', 'unsupported_format', representation)
  if (representation === 'metadata') return { data: metadata }
  if (!filePath) return { data: { ...metadata, reason: 'local_attachment_missing_or_unverified' } }
  if (kind === 'file') {
    if (representation !== 'file') return result(messageId, kind, 'unsupported', 'unsupported_format', representation)
    return { data: { ...metadata, local_path: filePath, size: (await stat(filePath)).size } }
  }
  const decoded = await imageData(runtime, body, accountDir, signal, filePath)
  if ('availability' in decoded) return result(messageId, kind, decoded.availability, decoded.reason, representation)
  if (representation === 'file') {
    try { await sharp(decoded.buffer).metadata() } catch { return result(messageId, kind, 'decode_failed', 'unsupported_image_data', representation) }
    if (!runtime.options?.userData) throw new Error('App data directory required')
    const directory = join(runtime.options.userData, 'media-cache', connected.accountScope)
    await mkdir(directory, { recursive: true })
    const extension = decoded.mime.split('/')[1].replace('jpeg', 'jpg')
    const path = join(directory, `${createHash('sha256').update(decoded.buffer).digest('hex')}.${extension}`)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, decoded.buffer, { flag: 'wx', mode: 0o600 })
    try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
    return { data: { ...metadata, local_path: path, mime_type: decoded.mime, size: decoded.buffer.length, transformed: decoded.transformed } }
  }
  const quality = args.quality ?? 'preview'
  let buffer = decoded.buffer
  let width: number | undefined
  let height: number | undefined
  let transformed = decoded.transformed
  try {
    const meta = await sharp(buffer).metadata()
    width = meta.width; height = meta.height
    if (quality === 'preview') {
      buffer = await sharp(buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
      transformed = true
      const previewMeta = await sharp(buffer).metadata(); width = previewMeta.width; height = previewMeta.height
    }
  } catch { return result(messageId, kind, 'decode_failed', 'image_decode_failed', representation) }
  const maxBytes = quality === 'preview' ? 4 * 1024 * 1024 : 10 * 1024 * 1024
  if (buffer.length > maxBytes) return { data: { message_id: messageId, kind, availability: 'too_large', representation, quality, mime_type: decoded.mime, width, height, transformed, source: 'local', reason: 'image_exceeds_output_budget' } }
  const mime = quality === 'preview' ? 'image/jpeg' : decoded.mime
  return {
    data: { ...metadata, message_id: messageId, kind, availability: 'available', representation, quality, mime_type: mime, width, height, transformed, source: 'local' },
    content: [{ type: 'image', data: b64(buffer), mimeType: mime }]
  }
}
