import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { readdir, realpath, stat } from 'fs/promises'
import { basename, dirname, join, relative, isAbsolute } from 'path'
import type { Attachment } from '../shared/chat/attachment'

export async function confinedFile(root: string, path: string): Promise<string | undefined> {
  try {
    const [base, target] = await Promise.all([realpath(root), realpath(path)])
    const rel = relative(base, target)
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return
    return (await stat(target)).isFile() ? target : undefined
  } catch { return }
}
export function accountRoot(path: string): string { return basename(path).toLowerCase() === 'db_storage' ? dirname(path) : path }

/** Read-only fallback for local layouts; no XML paths or network requests. */
export async function locateAttachment(root: string, attachment: Attachment, session: string, sentAt: string, signal?: AbortSignal): Promise<string | undefined> {
  root = accountRoot(root)
  const month = sentAt.slice(0, 7)
  const safeName = attachment.name && !/[\\/\x00-\x1f]/.test(attachment.name) && !['.', '..'].includes(attachment.name) ? attachment.name : undefined
  const dirs = attachment.kind === 'file'
    ? [join(root, 'msg', 'file', month), join(root, 'FileStorage', 'File', month), join(root, 'FileStorage', 'File')]
    : [join(root, 'msg', 'attach', createHash('md5').update(session).digest('hex'), month, 'Img'), join(root, 'FileStorage', 'Image', month), join(root, 'FileStorage', 'Image2', month)]
  if (!attachment.md5) return
  if (attachment.kind === 'file') {
    for (const base of [join(root, 'msg', 'file'), join(root, 'FileStorage', 'File')]) {
      const months = await readdir(base, { withFileTypes: true }).catch(() => [])
      for (const entry of months) if (entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)) {
        const dir = join(base, entry.name)
        if (!dirs.includes(dir)) dirs.push(dir)
      }
    }
  }
  for (const dir of dirs) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const candidates = entries.filter(e => e.isFile() && (attachment.kind === 'file' ? !!attachment.md5 || e.name === safeName : new RegExp(`^${attachment.md5}(?:_[ht])?\\.(?:dat|png|jpg|jpeg|gif|webp|bmp|heic|heif)$`, 'i').test(e.name)))
      .sort((a, b) => attachment.kind === 'file' ? Number(b.name === safeName) - Number(a.name === safeName) : (a.name.endsWith('_h.dat') ? 0 : a.name.endsWith('_t.dat') ? 2 : 1) - (b.name.endsWith('_h.dat') ? 0 : b.name.endsWith('_t.dat') ? 2 : 1))
    for (const entry of candidates) {
      const path = await confinedFile(root, join(dir, entry.name))
      if (!path) continue
      if (attachment.kind === 'file') {
        const info = await stat(path)
        if (attachment.size !== undefined && info.size !== attachment.size) continue
        // Title alone cannot distinguish two different files with the same name.
        if (!attachment.md5) continue
        const hash = createHash('md5')
        for await (const chunk of createReadStream(path)) { if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }); hash.update(chunk) }
        if (hash.digest('hex') !== attachment.md5) continue
      }
      return path
    }
  }
}
