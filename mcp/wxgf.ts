import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Mirrors the Electron decoder's VPS grouping: the largest stream is usually
// the colour image; a smaller independent stream can be an alpha mask.
export function wxgfCandidates(buffer: Buffer): Buffer[] {
  const starts: Array<{ at: number; prefix: number }> = []
  for (let i = 4; i + 4 < buffer.length; i++) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && (buffer[i + 2] === 1 || (buffer[i + 2] === 0 && buffer[i + 3] === 1))) {
      const prefix = buffer[i + 2] === 1 ? 3 : 4
      starts.push({ at: i, prefix }); i += prefix - 1
    }
  }
  const units = starts.map((s, i) => buffer.subarray(s.at + s.prefix, starts[i + 1]?.at ?? buffer.length))
    .filter(unit => unit.length >= 2 && !(unit[0] & 0x80))
  const groups: Buffer[] = []
  let current: Buffer[] = []
  const flush = () => {
    if (current.some(u => ((u[0] >> 1) & 63) < 32)) groups.push(Buffer.concat(current.flatMap(u => [Buffer.from([0, 0, 0, 1]), u])))
    current = []
  }
  for (const unit of units) {
    if (((unit[0] >> 1) & 63) === 32) { flush(); current = [unit] }
    else if (current.length) current.push(unit)
  }
  flush()
  return groups.sort((a, b) => b.length - a.length).slice(0, 16)
}

function ffmpegPaths(resourcesPath?: string): string[] {
  const paths: string[] = []
  try { const p = require('ffmpeg-static'); if (typeof p === 'string') paths.push(p.replace('app.asar', 'app.asar.unpacked')) } catch { /* optional */ }
  if (resourcesPath) paths.push(join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  paths.push(join(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  return [...new Set(paths.filter(existsSync)), 'ffmpeg']
}

function convert(executable: string, input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-v', 'error', '-f', 'hevc', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []; let size = 0; let settled = false
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { child.kill(); reject(error) } else resolve(Buffer.concat(chunks))
    }
    const abort = () => finish(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }))
    const timer = setTimeout(() => finish(new Error('ffmpeg timeout')), 30000)
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    child.on('error', finish); child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) finish(new Error('ffmpeg output too large')); else chunks.push(chunk) })
    child.on('close', code => code === 0 && size ? finish() : finish(new Error('ffmpeg failed')))
    child.stdin.end(input)
  })
}

export async function wxgfToJpeg(buffer: Buffer, resourcesPath?: string, signal?: AbortSignal): Promise<Buffer> {
  const candidates = wxgfCandidates(buffer)
  for (const executable of ffmpegPaths(resourcesPath)) for (const candidate of candidates) {
    try { return await convert(executable, candidate, signal) } catch (error) { if (signal?.aborted) throw error }
  }
  throw new Error('WXGF conversion failed')
}
