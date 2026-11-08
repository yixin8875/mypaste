import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Update } from '@tauri-apps/plugin-updater'

export type Kind = 'text' | 'link' | 'image' | 'file'
export type FileEntry = { path: string; size: number | null; modifiedAt: number | null; isDir: boolean }
export type Clip = {
  id: number; title: string; content: string; type: Kind; source: string
  time: string; day: string; capturedAt: number; deletedAt: number | null
  favorite: boolean; collections: string[]; note: string; deleted: boolean
  fileSize: number; fileModifiedAt: number | null; files: FileEntry[]
  lastUsedAt: number | null; useCount: number
}
export type Settings = { paused: boolean; retentionDays: number; maxItems: number; shortcut: string; excludedApps: string[] }
export type RuntimeStatus = { captureState: 'running' | 'paused' | 'error'; captureError: string | null; shortcutRegistered: boolean; shortcutError: string | null }
export type Snapshot = { items: Clip[]; collections: string[]; settings: Settings; status: RuntimeStatus; dataDir: string }
export type ClipPatch = Partial<Pick<Clip, 'title' | 'note' | 'favorite' | 'collections' | 'deleted'>>
export type PasteOutcome = { copied: boolean; status: 'input_sent' | 'manual_required' | 'clipboard_failed'; reason: string | null }
export type UpdateCheck = { version: string; currentVersion: string; notes: string; date: string | null }
export type UpdateProgress = { downloaded: number; total: number | null }
export const native = isTauri()
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : '操作失败，请重试'

// Browser previews alone use fixtures. Native errors never fall back to fixtures.
const now = Date.now()
const fixtures: [string, string, Kind, string, boolean, string][] = [
  ['让每一次复制，都有迹可循', '好的工具，应该让你更专注于手上的事。\n\nMyPaste 帮你记住复制过的文字、链接和图片。那些一闪而过的灵感、反复查找的地址、随手截下的画面，都可以在这里找到。\n\n少一点来回寻找，多一点心流。', 'text', '备忘录', true, '灵感收集'],
  ['Tauri 2 官方文档', 'https://v2.tauri.app/start/', 'link', 'Google Chrome', true, '开发片段'],
  ['工作空间 · 界面参考', '', 'image', '截图工具', false, '灵感收集'],
  ['React 自定义 Hook', "import { useEffect, useState } from 'react';\n\nexport function useDebounce<T>(value: T, delay = 200) {\n  const [result, setResult] = useState(value);\n  useEffect(() => {\n    const timer = setTimeout(() => setResult(value), delay);\n    return () => clearTimeout(timer);\n  }, [value, delay]);\n  return result;\n}", 'text', 'Visual Studio Code', false, '开发片段'],
  ['周末的阅读清单', '周末留一点时间给阅读。\n\n《设计心理学》\n《深度工作》\n《悉达多》', 'text', '微信', false, '日常工作'],
  ['Tailwind CSS', 'https://tailwindcss.com/docs', 'link', 'Google Chrome', false, '开发片段'],
  ['项目会议纪要', '本周设计同步\n\n确定三栏主窗口布局。\n优先完成文本、链接、图片预览。\n快捷窗口保持轻量。', 'text', '飞书', false, '日常工作'],
  ['Linear · 界面灵感', 'https://linear.app', 'link', 'Google Chrome', true, '灵感收集'],
  ['品牌色彩与留白', '', 'image', '截图工具', false, '灵感收集'],
  ['一段暂时不用的文字', '这条示例记录已移到最近删除，可以恢复或彻底删除。', 'text', '备忘录', false, ''],
  ['设计素材与宣传片', 'C:\\Synthetic\\Assets\\logo.svg\nC:\\Synthetic\\Assets\\宣传片.mp4\nC:\\Synthetic\\Assets\\素材文件夹', 'file', '文件资源管理器', false, '灵感收集'],
]
const demo: Snapshot = {
  items: fixtures.map(([title, content, type, source, favorite, collection], i) => {
    const capturedAt = now - (i < 6 ? i * 300000 : 86400000 + i * 300000)
    const files: FileEntry[] = type === 'file' ? content.split('\n').map((path, j) => ({ path, size: j === 2 ? null : [2412544, 1288490189][j] ?? 1024, modifiedAt: j === 2 ? null : capturedAt - j * 3600000, isDir: j === 2 })) : []
    const fileSize = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
    const fileModifiedAt = files.reduce<number | null>((latest, entry) => entry.modifiedAt !== null && (latest === null || entry.modifiedAt > latest) ? entry.modifiedAt : latest, null)
    const useCount = [11, 4, 1, 7, 2, 3, 1, 5, 0, 1, 2][i] ?? 0
    return { id: i + 1, title, content, type, source, favorite, collections: collection ? [collection] : [], note: '', capturedAt, day: i < 6 ? '今天' : '昨天', time: new Date(capturedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), deleted: i === 9, deletedAt: i === 9 ? now : null, fileSize, fileModifiedAt, files, lastUsedAt: useCount ? capturedAt + 60000 : null, useCount }
  }),
  collections: ['日常工作', '开发片段', '灵感收集'],
  settings: { paused: false, retentionDays: 30, maxItems: 500, shortcut: 'Ctrl+Shift+V', excludedApps: [] },
  status: { captureState: 'running', captureError: null, shortcutRegistered: false, shortcutError: null }, dataDir: '',
}
let pendingUpdate: Update | null = null
const listeners = new Set<() => void>()
function notify() { listeners.forEach(fn => fn()) }
function demoItem(id: number) { const item = demo.items.find(c => c.id === id); if(!item) throw new Error('记录不存在'); return item }
// Fictional inline artwork so browser previews can exercise lazy thumbnails without external files.
function demoThumb(id: number) {
  const hue = (id * 47) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 42% 76%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 38% 44%)"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><rect x="24" y="24" width="180" height="12" rx="6" fill="#fff" opacity=".72"/><rect x="24" y="48" width="120" height="12" rx="6" fill="#fff" opacity=".5"/><rect x="24" y="120" width="272" height="56" rx="10" fill="#fff" opacity=".22"/></svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}
function markDemoUsed(item: Clip) {
  item.lastUsedAt = Date.now()
  item.useCount += 1
}
export const clipboardService = {
  async snapshot(): Promise<Snapshot> { return native ? invoke('get_snapshot') : structuredClone(demo) },
  async item(id: number): Promise<Clip> { return native ? invoke('get_item', { id }) : structuredClone(demoItem(id)) },
  async search(query: string): Promise<number[]> {
    if(native) return invoke('search_items', { query })
    const term = query.toLowerCase()
    return demo.items.filter(c => `${c.title} ${c.content} ${c.note} ${c.collections.join(' ')}`.toLowerCase().includes(term)).map(c => c.id)
  },
  async update(id: number, patch: ClipPatch): Promise<void> {
    if(native) return invoke('update_item', { id, patch })
    const item = demoItem(id); Object.assign(item, patch)
    if(patch.deleted !== undefined) item.deletedAt = patch.deleted ? Date.now() : null
    notify()
  },
  async purge(id: number): Promise<void> {
    if(native) return invoke('purge_item', { id })
    if(!demoItem(id).deleted) throw new Error('只能彻底删除回收站中的记录')
    demo.items = demo.items.filter(c => c.id !== id); notify()
  },
  async createCollection(name: string): Promise<void> {
    if(native) return invoke('create_collection', { name })
    if(!name.trim() || name.trim().length > 80 || demo.collections.includes(name.trim()) || ['全部记录','收藏','最近删除','text','link','image','file'].includes(name.trim())) throw new Error('集合名称已存在或不可用')
    demo.collections.push(name.trim()); notify()
  },
  async settings(patch: Partial<Settings>): Promise<void> {
    if(native) return invoke('update_settings', { patch })
    Object.assign(demo.settings, patch); demo.status.captureState = demo.settings.paused ? 'paused' : 'running'; notify()
  },
  async copy(id: number): Promise<void> {
    if(native) return invoke('copy_item', { id })
    const item = demoItem(id)
    if(item.deleted) throw new Error('请先恢复这条记录')
    if(item.type === 'image') throw new Error('浏览器图片为示例，请在桌面版复制真实图片')
    if(item.type === 'file') throw new Error('浏览器文件为示例，请在桌面版复制真实文件')
    if(!navigator.clipboard) throw new Error('浏览器不支持剪贴板写入，请使用桌面版')
    await navigator.clipboard.writeText(item.content)
    markDemoUsed(item); notify()
  },
  async paste(id: number): Promise<PasteOutcome> {
    if(native) return invoke('paste_item', { id })
    await this.copy(id)
    return { copied: true, status: 'manual_required', reason: '已复制，请在目标应用按 Ctrl+V' }
  },
  async image(id: number): Promise<string> { return native ? invoke('get_image', { id }) : demoThumb(id) },
  async thumbnail(id: number): Promise<string> {
    if(native) return invoke('get_thumbnail', { id })
    return demoItem(id).type === 'image' ? demoThumb(id) : ''
  },
  async version(): Promise<string> {
    if(!native) return '0.2.0'
    const { getVersion } = await import('@tauri-apps/api/app')
    return getVersion()
  },
  async checkUpdate(): Promise<UpdateCheck | null> {
    if(!native) return null
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    pendingUpdate = update
    return update ? { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? '', date: update.date ?? null } : null
  },
  async installUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    if(!native) throw new Error('浏览器演示不支持安装更新')
    if(!pendingUpdate) throw new Error('请先检查更新')
    let total: number | null = null, downloaded = 0
    await pendingUpdate.downloadAndInstall(event => {
      const data = (event as { data?: { contentLength?: number; chunkLength?: number } }).data
      if(event.event === 'Started') { total = data?.contentLength ?? null; downloaded = 0; onProgress({ downloaded, total }) }
      else if(event.event === 'Progress') { downloaded += data?.chunkLength ?? 0; onProgress({ downloaded, total }) }
    })
    pendingUpdate = null
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  },
  async openLink(id: number): Promise<void> {
    if(native) return invoke('open_link', { id })
    const url = new URL(demoItem(id).content.trim())
    if(!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接')
    window.open(url.href, '_blank', 'noopener,noreferrer')
  },
  async hideQuick(): Promise<void> { if(native) await invoke('hide_quick_window') },
  async subscribe(onChange: () => void, onQuickOpen: () => void): Promise<UnlistenFn> {
    if(!native) { listeners.add(onChange); return () => { listeners.delete(onChange) } }
    const unlisten: UnlistenFn[] = []
    try {
      unlisten.push(await listen('history://changed', onChange))
      unlisten.push(await listen('capture://status', onChange))
      unlisten.push(await listen('desktop://quick-open', onQuickOpen))
    } catch(error) { unlisten.forEach(fn => fn()); throw error }
    return () => unlisten.forEach(fn => fn())
  },
}
