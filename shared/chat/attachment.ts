/** Metadata only: XML is untrusted and never supplies a filesystem path. */
export type Attachment = { kind: string; title?: string; url?: string; availability: string; id?: string; name?: string; size?: number; md5?: string; file_type?: string; variant?: string; downloaded?: boolean }
export function attachmentMetadata(raw: string, id: string, kind: string): Partial<Attachment> {
  const decode = (value: string) => value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_whole, digits: string) => {
    const code = digits[0].toLowerCase() === 'x' ? parseInt(digits.slice(1), 16) : Number(digits)
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD'
  }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  const tag = (name: string) => {
    const value = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(raw)?.[1]
    if (value === undefined) return
    return value.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g).map(part => part.startsWith('<![CDATA[') ? part.slice(9, -3) : decode(part)).join('')
  }
  const md5 = tag('md5') || tag('filemd5') || /\b(?:md5|imgmd5|origmd5)=["']([a-f\d]{32})["']/i.exec(raw)?.[1]
  const size = Number(tag('totallen') ?? /\blength=["'](\d+)["']/i.exec(raw)?.[1])
  return { id: `att:${id}`, ...(kind === 'file' && tag('title') ? { name: tag('title') } : {}), ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}), ...(md5 && /^[a-f\d]{32}$/i.test(md5) ? { md5: md5.toLowerCase() } : {}), ...(tag('fileext') ? { file_type: tag('fileext') } : {}), ...(kind === 'image' ? { variant: 'unknown' } : {}) }
}
