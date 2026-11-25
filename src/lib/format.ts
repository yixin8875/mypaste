import type { Clip, FileEntry, Kind } from '@/clipboard-service'

export const typeNames: Record<Kind, string> = { text: '文本', link: '链接', image: '图片', file: '文件' }

export function dayOf(clip: Clip) {
  const date = new Date(clip.capturedAt), today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  return date >= today ? '今天' : date >= yesterday ? '昨天' : date.toLocaleDateString('sv-SE')
}

export function hostname(content: string) { try { return new URL(content.trim()).hostname } catch { return content } }

export const FILE_WARN = 1024 ** 3
export const appKey = (value: string) => value.trim().toLowerCase().replace(/\.exe$/, '')
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
export const filePaths = (content: string) => content.split('\n').filter(Boolean)

export function formatBytes(n: number) {
  if(n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if(n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB`
  if(n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export function formatModified(ms: number | null) { return ms === null ? '时间未知' : new Date(ms).toLocaleString('zh-CN', { hour12: false }) }

export function fileSummary(content: string, size = 0) {
  const names = filePaths(content).map(baseName)
  const label = names.length > 1 ? `${names[0]} 等 ${names.length} 项` : names[0] ?? '文件'
  return size > 0 ? `${label} · ${formatBytes(size)}` : label
}

export function fileEntries(clip: Clip): FileEntry[] {
  return clip.files.length ? clip.files : filePaths(clip.content).map(path => ({ path, size: null, modifiedAt: null, isDir: false }))
}

export const IMAGE_FILE = /\.(png|jpe?g|bmp)$/i
export function imageFile(clip: Clip) {
  if(clip.type !== 'file') return false
  const entries = fileEntries(clip)
  return entries.length === 1 && !entries[0].isDir && IMAGE_FILE.test(entries[0].path)
}
