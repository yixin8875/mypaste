import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clipboard, Search, Star, FileText, Link2, Image, Folder, FolderOpen, Plus, ChevronDown, Settings, Pause, Play, Trash2, Copy, X, Check, ArrowUpRight, Keyboard, ShieldCheck, ShieldOff, PanelLeftClose, SlidersHorizontal, RotateCcw, Zap, MoreHorizontal, Monitor, ArrowDown, ArrowUp, AlertCircle, Pin, PinOff, Database } from 'lucide-react'
import mypasteMark from './assets/mypaste-mark.svg'
import { clipboardService as service, errorMessage, native, type Clip, type ClipPatch, type CopyMode, type DbUsage, type FileEntry, type Kind, type LogInfo, type RichFormat, type UpdateCheck, type UpdateProgress } from './clipboard-service'
import { useClipboard, useClipDetail, useSearchIds } from './use-clipboard'

const typeNames = { text: '文本', link: '链接', image: '图片', file: '文件' }
function TypeIcon({ type, size = 19 }: { type: Kind; size?: number }) { const Icon = type === 'link' ? Link2 : type === 'image' ? Image : type === 'file' ? FolderOpen : FileText; return <Icon size={size}/> }
function IconButton({ label, children, onClick, active = false, disabled = false }: { label: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) { return <button disabled={disabled} className={`icon-button ${active ? 'is-active' : ''}`} title={label} aria-label={label} onClick={onClick}>{children}</button> }
function dayOf(clip: Clip) {
  const date = new Date(clip.capturedAt), today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  return date >= today ? '今天' : date >= yesterday ? '昨天' : date.toLocaleDateString('sv-SE')
}
function hostname(content: string) { try { return new URL(content.trim()).hostname } catch { return content } }
const FILE_WARN = 1024 ** 3
const appKey = (value: string) => value.trim().toLowerCase().replace(/\.exe$/, '')
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
const filePaths = (content: string) => content.split('\n').filter(Boolean)
function formatBytes(n: number) { if(n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`; if(n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB`; if(n >= 1024) return `${Math.round(n / 1024)} KB`; return `${n} B` }
function formatModified(ms: number | null) { return ms === null ? '时间未知' : new Date(ms).toLocaleString('zh-CN', { hour12: false }) }
function fileSummary(content: string, size = 0) { const names = filePaths(content).map(baseName); const label = names.length > 1 ? `${names[0]} 等 ${names.length} 项` : names[0] ?? '文件'; return size > 0 ? `${label} · ${formatBytes(size)}` : label }
function fileEntries(clip: Clip): FileEntry[] { return clip.files.length ? clip.files : filePaths(clip.content).map(path => ({ path, size: null, modifiedAt: null, isDir: false })) }
const IMAGE_FILE = /\.(png|jpe?g|bmp)$/i
function imageFile(clip: Clip) { if(clip.type !== 'file') return false; const entries = fileEntries(clip); return entries.length === 1 && !entries[0].isDir && IMAGE_FILE.test(entries[0].path) }
function Picture({ clip }: { clip: Clip }) {
  const [data, setData] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false; setData(''); setError('')
    if(native) void service.image(clip.id).then(url => { if(!cancelled) setData(url) }).catch(cause => { if(!cancelled) setError(errorMessage(cause)) })
    return () => { cancelled = true }
  }, [clip.id])
  if(native) return <div className="native-image-preview">{error ? <p role="alert">{error}</p> : data ? <img src={data} alt={clip.title}/> : <p>正在读取图片…</p>}</div>
  return <div className="picture-preview" role="img" aria-label="示例图片：蓝色山峰与浅色天空"><div className="picture-sun"/><div className="mountain mountain-back"/><div className="mountain mountain-front"/><div className="picture-caption">A little room to think.<span>给思绪，留一点空间。</span></div></div>
}
// Lazy thumbnail for list/quick rows. Loads only when the row approaches the viewport.
function Thumb({ clip }: { clip: Clip }) {
  const ref = useRef<HTMLDivElement>(null), [url, setUrl] = useState(''), [failed, setFailed] = useState(false)
  useEffect(() => {
    setUrl(''); setFailed(false)
    let cancelled = false
    const load = () => { void service.thumbnail(clip.id).then(data => { if(!cancelled) setUrl(data) }).catch(() => { if(!cancelled) setFailed(true) }) }
    if(typeof IntersectionObserver === 'undefined') { load(); return () => { cancelled = true } }
    const observer = new IntersectionObserver(entries => { if(entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load() } }, { rootMargin: '160px' })
    if(ref.current) observer.observe(ref.current)
    return () => { cancelled = true; observer.disconnect() }
  }, [clip.id])
  return <div ref={ref} className="clip-thumb">{url ? <img src={url} alt=""/> : failed ? <Image size={18}/> : <span className="thumb-pending"/>}</div>
}
type DraftStore = Map<string, { value: string; version: number; failed: boolean }>
export function Editable({ label, value, multiline = false, maxLength, disabled, save, cache, cacheKey = '' }: { label: string; value: string; multiline?: boolean; maxLength: number; disabled: boolean; save: (value: string) => Promise<boolean>; cache?: DraftStore; cacheKey?: string }) {
  const cached = cache?.get(cacheKey)
  const [draft, setDraft] = useState(cached?.value ?? value), [dirty, setDirty] = useState(!!cached), [failed, setFailed] = useState(cached?.failed ?? false)
  const focused = useRef(false), version = useRef(cached?.version ?? 0), mounted = useRef(true)
  const latest = useRef(value); latest.current = value
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if(!focused.current && !dirty) setDraft(value) }, [value, dirty])
  const props = {
    'aria-label': label, 'aria-invalid': failed, title: failed ? '尚未保存，失焦后重试；草稿已保留' : undefined,
    value: draft, disabled, maxLength, onFocus: () => { focused.current = true },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      version.current++; const next = e.target.value
      cache?.set(cacheKey, { value: next, version: version.current, failed: false })
      setDraft(next); setDirty(true); setFailed(false)
    },
    onBlur: async () => {
      focused.current = false
      if(!dirty) { setDraft(latest.current); return }
      const edit = version.current
      const ok = draft === latest.current || await save(draft)
      if(cache?.get(cacheKey)?.version === edit) {
        if(ok) cache.delete(cacheKey)
        else cache.set(cacheKey, { value: draft, version: edit, failed: true })
      }
      if(mounted.current && edit === version.current) { setFailed(!ok); if(ok) setDirty(false) }
    },
  }
  return multiline ? <textarea {...props} placeholder="添加一点备注，让下次更容易找到…"/> : <input {...props}/>
}
function Modal({ title, onClose, children, className = '', drag = false }: { title: string; onClose: () => void; children: ReactNode; className?: string; drag?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => {
    const prior = document.activeElement as HTMLElement, root = ref.current!
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')).filter(el => !el.hasAttribute('disabled'))
    ;(root.querySelector<HTMLElement>('input') ?? focusable()[0])?.focus()
    const handler = (e: KeyboardEvent) => {
      if(e.key === 'Escape') { e.preventDefault(); closeRef.current() }
      if(e.key === 'Tab') { const elements = focusable(), first = elements[0], last = elements[elements.length - 1]; if(e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() } else if(!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() } }
    }
    root.addEventListener('keydown', handler)
    return () => { root.removeEventListener('keydown', handler); prior?.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={e => { if(e.target === e.currentTarget) onClose() }}><div ref={ref} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-title" data-tauri-drag-region={drag ? '' : undefined}><h2 data-tauri-drag-region={drag ? '' : undefined}>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={19}/></IconButton></div>{children}</div></div>
}

export default function App() {
  const quickOnly = window.location.hash === '#quick'
  const [nav, setNav] = useState('全部记录'), [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [sourceFilter, setSourceFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<number>(), [modal, setModal] = useState<'settings' | 'quick' | 'collection' | null>(quickOnly ? 'quick' : null)
  const [collectionName, setCollectionName] = useState(''), [toast, setToast] = useState(''), [quickQuery, setQuickQuery] = useState(''), [quickIndex, setQuickIndex] = useState(0)
  const [settingsTab, setSettingsTab] = useState('通用'), [shortcutDraft, setShortcutDraft] = useState('Ctrl+Shift+V'), [appDraft, setAppDraft] = useState('')
  const [quickKind, setQuickKind] = useState<'all' | Kind>('all'), [quickCollection, setQuickCollection] = useState('all'), [quickSort, setQuickSort] = useState<'recent' | 'used'>('recent'), [quickNotice, setQuickNotice] = useState('')
  const [appVersion, setAppVersion] = useState(''), [updateState, setUpdateState] = useState<'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'error'>('idle')
  const [updateInfo, setUpdateInfo] = useState<UpdateCheck | null>(null), [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null), [updateError, setUpdateError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null), [sidebarOpen, setSidebarOpen] = useState(false), [copying, setCopying] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<string | null>(null), [pendingDataDir, setPendingDataDir] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set()), [copyMenu, setCopyMenu] = useState(false)
  const [bulkDelete, setBulkDelete] = useState(false), [manageCollections, setManageCollections] = useState(false)
  const [renameTarget, setRenameTarget] = useState(''), [renameDraft, setRenameDraft] = useState('')
  const [usage, setUsage] = useState<DbUsage | null>(null), [compacting, setCompacting] = useState(false)
  const [logInfo, setLogInfo] = useState<LogInfo | null>(null), [pendingElevated, setPendingElevated] = useState(false)
  const [deleteCollectionTarget, setDeleteCollectionTarget] = useState('')
  const drafts = useRef<DraftStore>(new Map())
  const desktopQuick = useRef(quickOnly), quickSession = useRef(0), searchRef = useRef<HTMLInputElement>(null)
  const { snapshot, loading, busy, error, revision, run, refresh, dismissError } = useClipboard(() => { quickSession.current++; desktopQuick.current = true; setConfirmDelete(null); setQuickQuery(''); setQuickIndex(0); setQuickNotice(''); setModal('quick') })
  const clips = snapshot?.items ?? [], collections = snapshot?.collections ?? [], settings = snapshot?.settings, status = snapshot?.status, paused = settings?.paused ?? false
  const sequence = snapshot?.sequence, collectionPolicies = snapshot?.collectionPolicies ?? []
  const policyFor = (name: string) => collectionPolicies.find(policy => policy.name === name) ?? { name, retentionDays: null, maxItems: null }
  const mainSearch = useSearchIds(query, revision), quickSearch = useSearchIds(quickQuery, revision)
  const active = clips.filter(c => !c.deleted)
  const sources = [...new Set(clips.filter(c => c.deleted === (nav === '最近删除')).map(c => c.source).filter(Boolean))]
  const visible = clips.filter(c => c.deleted === (nav === '最近删除') && (nav !== '收藏' || c.favorite) && (!['text','link','image','file'].includes(nav) || c.type === nav) && (!collections.includes(nav) || c.collections.includes(nav)) && (kind === 'all' || c.type === kind) && (sourceFilter === 'all' || c.source === sourceFilter) && (!mainSearch.ids || mainSearch.ids.has(c.id))).sort((a, b) => Number(b.pinned) - Number(a.pinned))
  const summary = visible.find(c => c.id === selectedId) ?? visible[0]
  const { detail, error: detailError } = useClipDetail(summary?.id, revision)
  const selected = detail ?? summary, heading = Object.hasOwn(typeNames, nav) ? typeNames[nav as Kind] : nav
  const quickMatches = active.filter(c => (quickKind === 'all' || c.type === quickKind) && (quickCollection === 'all' || c.collections.includes(quickCollection)) && (!quickSearch.ids || quickSearch.ids.has(c.id)))
  const quickItems = [...quickMatches].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (quickSort === 'used' ? (b.useCount - a.useCount || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.capturedAt - a.capturedAt) : b.capturedAt - a.capturedAt))
  const quickSelected = quickItems[Math.min(quickIndex, Math.max(0, quickItems.length - 1))]
  const deletionTarget = clips.find(c => c.id === confirmDelete)
  const notice = (text: string) => setToast(text)
  useEffect(() => { if(!toast) return; const id = setTimeout(() => setToast(''), 5000); return () => clearTimeout(id) }, [toast])
  useEffect(() => { if(settings) setShortcutDraft(settings.shortcut) }, [settings?.shortcut])
  const visibleKey = visible.map(c => c.id).join(',')
  useEffect(() => { const ids = new Set(visible.map(c => c.id)); setChecked(prev => [...prev].every(id => ids.has(id)) ? prev : new Set([...prev].filter(id => ids.has(id)))) }, [visibleKey])
  useEffect(() => {
    if(modal !== 'settings' || settingsTab !== '数据') return
    let cancelled = false
    void service.dataUsage().then(value => { if(!cancelled) setUsage(value) }).catch(() => { if(!cancelled) setUsage(null) })
    return () => { cancelled = true }
  }, [modal, settingsTab, revision])
  useEffect(() => {
    if(modal !== 'settings' || settingsTab !== '数据') return
    let cancelled = false
    void service.logInfo().then(value => { if(!cancelled) setLogInfo(value) }).catch(() => { if(!cancelled) setLogInfo(null) })
    return () => { cancelled = true }
  }, [modal, settingsTab, revision])
  useEffect(() => { setCopyMenu(false) }, [selected?.id])
  useEffect(() => { if(!checked.size) setBulkDelete(false) }, [checked])
  useEffect(() => { void service.version().then(setAppVersion).catch(() => setAppVersion('')) }, [])
  useEffect(() => { if(modal === 'quick') document.getElementById(`quick-${quickSelected?.id}`)?.scrollIntoView({ block: 'nearest' }) }, [modal, quickSelected?.id])
  useEffect(() => { if(!quickOnly) return; const onFocus = () => void refresh(); window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus) }, [quickOnly, refresh])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !modal) { e.preventDefault(); searchRef.current?.focus() } if(!native && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v' && confirmDelete === null) { e.preventDefault(); quickSession.current++; desktopQuick.current = false; setModal('quick') } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [modal, confirmDelete])
  const update = (id: number, patch: ClipPatch) => run(() => service.update(id, patch))
  async function closeModal(session = quickSession.current) {
    if(session !== quickSession.current) return
    if(desktopQuick.current) {
      try { await service.hideQuick() } catch(cause) { notice(errorMessage(cause)); return }
      if(session !== quickSession.current) return
    }
    desktopQuick.current = false; quickSession.current++; setModal(null); setQuickNotice('')
  }
  function openQuick() { quickSession.current++; desktopQuick.current = false; setQuickQuery(''); setQuickIndex(0); setQuickNotice(''); setModal('quick') }
  async function copy(c: Clip, close = false, paste = false) {
    if(copying) return; const session = quickSession.current; setCopying(true); setQuickNotice('')
    try {
      if(paste) {
        const outcome = await service.paste(c.id)
        if(!outcome.copied) throw new Error(outcome.reason ?? '无法写入剪贴板，请重试')
        // Copy succeeded but input was not sent: keep the quick window open with the reason visible.
        if(outcome.status === 'manual_required') { setQuickNotice(outcome.reason ?? '已复制，请在目标应用按 Ctrl+V'); return }
        notice('已发送粘贴快捷键，请确认目标内容')
      } else { await service.copy(c.id); notice('已复制到剪贴板') }
      if(close && session === quickSession.current) await closeModal(session)
    } catch(cause) { const message = errorMessage(cause); if(close) setQuickNotice(message); notice(message) } finally { setCopying(false) }
  }
  async function excludeApp(name: string) {
    const app = name.trim()
    if(!app || !settings) return
    if(settings.excludedApps.some(existing => appKey(existing) === appKey(app))) { notice(`${app} 已在排除列表中`); return }
    if(await run(() => service.settings({ excludedApps: [...settings.excludedApps, app] }))) notice(`将不再记录来自 ${app} 的内容`)
  }
  async function removeExcluded(name: string) {
    if(settings && await run(() => service.settings({ excludedApps: settings.excludedApps.filter(app => app !== name) }))) notice(`已恢复记录来自 ${name} 的内容`)
  }
  async function checkUpdates() {
    setUpdateState('checking'); setUpdateError(''); setUpdateInfo(null); setUpdateProgress(null)
    try {
      const info = await service.checkUpdate()
      if(info) { setUpdateInfo(info); setUpdateState('available') } else setUpdateState('latest')
    } catch(cause) { setUpdateError(errorMessage(cause)); setUpdateState('error') }
  }
  async function installUpdate() {
    setUpdateState('downloading'); setUpdateError(''); setUpdateProgress({ downloaded: 0, total: null })
    try {
      await service.installUpdate(setUpdateProgress)
      setUpdateState('idle'); setUpdateInfo(null); notice('更新已安装，正在重启…')
    } catch(cause) { setUpdateError(errorMessage(cause)); setUpdateState('error') }
  }
  async function togglePaused() { await run(() => service.settings({ paused: !paused })) }
  async function openLink(c: Clip) { try { await service.openLink(c.id) } catch(cause) { notice(errorMessage(cause)) } }
  async function exportBackup() {
    try { const path = await service.exportBackup(); if(path) notice(`备份已导出到 ${path}`) } catch(cause) { notice(errorMessage(cause)) }
  }
  async function pickRestore() {
    try { const path = await service.pickBackup(); if(path) setPendingRestore(path) } catch(cause) { notice(errorMessage(cause)) }
  }
  async function restoreBackup() {
    if(!pendingRestore) return
    try { await service.importBackup(pendingRestore); setPendingRestore(null); await refresh(); notice('已从备份恢复') } catch(cause) { setPendingRestore(null); notice(errorMessage(cause)) }
  }
  async function chooseDataDir() {
    try { const path = await service.chooseDataDir(); if(path && path !== snapshot?.dataDir) setPendingDataDir(path) } catch(cause) { notice(errorMessage(cause)) }
  }
  async function moveDataDir() {
    if(!pendingDataDir) return
    try { await service.setDataDir(pendingDataDir); notice('正在迁移数据并重启…') } catch(cause) { setPendingDataDir(null); notice(errorMessage(cause)) }
  }
  async function openDataDir() { try { await service.openDataDir() } catch(cause) { notice(errorMessage(cause)) } }
  function go(value: string) { setNav(value); setQuery(''); setKind('all'); setSourceFilter('all'); setSelectedId(undefined); setSidebarOpen(false) }
  function navButton(value: string, icon: ReactNode, count?: number) { return <button className={`nav-item ${nav === value ? 'selected' : ''}`} onClick={() => go(value)}>{icon}<span>{Object.hasOwn(typeNames, value) ? typeNames[value as Kind] : value}</span>{count !== undefined && <small>{count}</small>}</button> }
  async function restore(id: number) { if(await update(id, { deleted: false })) notice('记录已恢复') }
  const selectAnchor = useRef<number | null>(null)
  function selectRow(c: Clip, e: React.MouseEvent) {
    const ids = visible.map(item => item.id)
    if(e.shiftKey) {
      const end = ids.indexOf(c.id), start = Math.max(0, ids.indexOf(selectAnchor.current ?? c.id))
      if(end >= 0) setChecked(new Set(ids.slice(Math.min(start, end), Math.max(start, end) + 1)))
      if(selectAnchor.current === null) selectAnchor.current = c.id
    } else if(e.ctrlKey || e.metaKey) {
      const next = new Set(checked)
      if(next.has(c.id)) next.delete(c.id); else next.add(c.id)
      setChecked(next)
      selectAnchor.current = c.id
    } else {
      setChecked(new Set())
      selectAnchor.current = c.id
    }
    setSelectedId(c.id)
  }
  async function batchPatch(patch: ClipPatch, message: string) {
    if(!checked.size) return
    if(await run(() => service.updateMany([...checked], patch))) notice(message)
  }
  async function batchAdd(name: string) {
    if(!name || !checked.size) return
    if(await run(() => service.addToCollection([...checked], name))) { notice(`已加入「${name}」`); setChecked(new Set()) }
  }
  async function batchDelete() {
    const count = checked.size
    if(!count) return
    if(await run(() => service.updateMany([...checked], { deleted: true }))) { setBulkDelete(false); setChecked(new Set()); notice(`已移除 ${count} 条记录`) }
  }
  async function copyVariant(c: Clip, mode: CopyMode) {
    setCopyMenu(false)
    try {
      await service.copyVariant(c.id, mode)
      notice(mode === 'trim' ? '已复制，首尾空白已去除' : mode === 'one_line' ? '已复制为单行' : '已复制为纯文本')
      await refresh()
    } catch(cause) { notice(errorMessage(cause)) }
  }
  async function copyFormat(c: Clip, format: RichFormat) {
    setCopyMenu(false)
    try {
      await service.copyFormat(c.id, format)
      notice(format === 'rtf' ? '已复制为 RTF 格式' : '已复制为 HTML 格式')
      await refresh()
    } catch(cause) { notice(errorMessage(cause)) }
  }
  function startRename(name: string) { setRenameTarget(name); setRenameDraft(name) }
  async function commitRename() {
    if(!renameTarget) return
    const next = renameDraft.trim()
    if(!next || next === renameTarget) { setRenameTarget(''); return }
    if(await run(() => service.renameCollection(renameTarget, next))) {
      if(nav === renameTarget) setNav(next)
      if(quickCollection === renameTarget) setQuickCollection(next)
      setRenameTarget(''); notice('集合已重命名')
    }
  }
  async function removeCollection(name: string) {
    if(await run(() => service.deleteCollection(name))) {
      if(nav === name) go('全部记录')
      if(quickCollection === name) setQuickCollection('all')
      setDeleteCollectionTarget(''); setRenameTarget('')
      notice(`已删除集合「${name}」，记录仍保留`)
    }
  }
  async function moveCollection(name: string, direction: 'up' | 'down') { await run(() => service.moveCollection(name, direction)) }
  async function toggleAutostart() {
    try {
      const enabled = await service.setAutostart(!(status?.autostart ?? false))
      await refresh(); notice(enabled ? '已开启开机启动' : '已关闭开机启动')
    } catch(cause) { notice(errorMessage(cause)) }
  }
  async function compact() {
    setCompacting(true)
    try { setUsage(await service.compactDatabase()); notice('数据库已整理') } catch(cause) { notice(errorMessage(cause)) } finally { setCompacting(false) }
  }
  async function startSequence() {
    if(!checked.size) return
    try {
      const status = await service.startSequence([...checked])
      setChecked(new Set())
      notice(status.active ? `序列粘贴已开始（共 ${status.total} 条），按 ${settings?.shortcut ?? 'Ctrl+Shift+V'} 粘贴下一项` : '已复制所选记录')
    } catch(cause) { notice(errorMessage(cause)) }
  }
  async function nextSequence() {
    try {
      const status = await service.sequenceNext()
      notice(status.active ? `已复制第 ${status.position}/${status.total} 项` : '序列粘贴已完成')
    } catch(cause) { notice(errorMessage(cause)) }
  }
  async function stopSequence() {
    try { await service.stopSequence(); notice('序列粘贴已结束') } catch(cause) { notice(errorMessage(cause)) }
  }
  async function savePolicy(name: string, retentionDays: number | null, maxItems: number | null) {
    if(await run(() => service.setCollectionPolicy(name, retentionDays, maxItems))) notice(retentionDays === null && maxItems === null ? `「${name}」已跟随全局保留策略` : `已更新「${name}」的保留策略`)
  }
  async function restartElevated() {
    setPendingElevated(false)
    try { await service.restartElevated(); notice('正在以管理员身份重启…') } catch(cause) { notice(errorMessage(cause)) }
  }
  async function openLogDir() { try { await service.openLogDir() } catch(cause) { notice(errorMessage(cause)) } }
  async function exportDiagnostics() {
    try { const path = await service.exportDiagnostics(); if(path) notice(`诊断信息已导出到 ${path}`) } catch(cause) { notice(errorMessage(cause)) }
  }
  const banner = error || mainSearch.error || quickSearch.error || detailError
  return <div className={`app-shell ${quickOnly ? 'quick-only' : ''}`}>
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <div className="brand"><div className="brand-icon"><img src={mypasteMark} alt=""/></div><div>MyPaste<span>你的随身剪贴板</span></div><IconButton label="收起侧栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17}/></IconButton></div>
      <div className="nav-group">{navButton('全部记录', <Clipboard size={18}/>, active.length)}{navButton('收藏', <Star size={18}/>, active.filter(c => c.favorite).length)}</div><div className="section-label">内容类型</div>
      <div className="nav-group">{(['text','link','image','file'] as Kind[]).map(type => <div key={type}>{navButton(type, <TypeIcon type={type} size={18}/>, active.filter(c => c.type === type).length)}</div>)}</div>
      <div className="section-label">我的集合<span className="section-actions"><IconButton label="新建集合" disabled={!snapshot} onClick={() => setModal('collection')}><Plus size={16}/></IconButton><IconButton label="管理集合" disabled={!snapshot || collections.length === 0} onClick={() => setManageCollections(true)}><SlidersHorizontal size={15}/></IconButton></span></div>
      <div className="nav-group">{collections.map((name, i) => <button key={name} className={`nav-item ${nav === name ? 'selected' : ''}`} onClick={() => go(name)}><Folder size={18} className={`folder-color-${i % 3}`}/><span>{name}</span></button>)}</div>
      <div className="sidebar-bottom">{navButton('最近删除', <Trash2 size={18}/>)}<div className="sidebar-divider"/><button disabled={!snapshot || busy} className="capture-state" onClick={() => void togglePaused()}><span className={`status-dot ${paused || status?.captureState === 'error' ? 'paused' : ''}`}/><span>{!snapshot ? '正在连接本地服务' : paused ? '记录已暂停' : status?.captureState === 'error' ? '记录服务异常' : native ? '正在记录剪贴板' : '演示记录状态'}<small>{native ? status?.captureError ?? (paused ? '点击恢复记录' : '后台监听已连接') : '浏览器不监听剪贴板'}</small></span>{paused ? <Play size={15}/> : <Pause size={15}/>}</button><button className="nav-item" onClick={() => setModal('settings')}><Settings size={18}/><span>设置</span></button><div className="local-label"><ShieldCheck size={13}/>本地优先，安心留存</div></div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><button className="mobile-menu icon-button" aria-label="打开导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Clipboard size={19}/></button><div className="breadcrumb"><strong>{heading}</strong></div><div className="topbar-right"><span className="prototype-badge">{native ? '本地模式' : '浏览器演示'}</span><button className="quiet-button" onClick={openQuick}><Keyboard size={16}/>快捷窗口<kbd>{settings?.shortcut ?? 'Ctrl+Shift+V'}</kbd></button><span className="top-divider"/><IconButton label="设置" onClick={() => setModal('settings')}><SlidersHorizontal size={18}/></IconButton></div></header>
      {banner && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{banner}</span><button onClick={() => void refresh()}>重新加载</button><IconButton label="关闭错误提示" onClick={dismissError}><X size={14}/></IconButton></div>}
      <div className="content-shell"><section className="list-pane" aria-label="剪贴记录">
        <div className="list-heading"><div><h1>{heading}</h1><span>{visible.length} 条记录<span className="heading-dot">·</span>{nav === '最近删除' ? '7 天后自动清理' : '留住每一次灵感'}</span></div><IconButton label="查看快捷窗口" onClick={openQuick}><MoreHorizontal size={21}/></IconButton></div>
        <div className="search-box"><Search size={17}/><input ref={searchRef} aria-label="搜索记录" maxLength={1000} placeholder="搜索你的剪贴记录…" value={query} onChange={e => setQuery(e.target.value)}/>{query ? <button aria-label="清空搜索" onClick={() => setQuery('')}><X size={14}/></button> : <kbd>Ctrl K</kbd>}</div>
        <div className="list-toolbar"><div className="toolbar-filters"><label><select aria-label="内容类型筛选" value={kind} onChange={e => setKind(e.target.value)}><option value="all">所有类型</option><option value="text">文本</option><option value="link">链接</option><option value="image">图片</option><option value="file">文件</option></select><ChevronDown size={13}/></label><label><select aria-label="来源应用筛选" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">所有来源</option>{sources.map(source => <option key={source} value={source}>{source}</option>)}</select><ChevronDown size={13}/></label></div><span>{busy ? '正在保存…' : '最近复制'}<ArrowDown size={13}/></span></div>
        {checked.size > 0 && nav !== '最近删除' && <div className="bulk-bar" role="region" aria-label="批量操作"><span className="bulk-count">已选择 {checked.size} 项</span><div className="bulk-actions"><button className="text-button" disabled={busy} onClick={() => void batchPatch({ favorite: true }, '已收藏所选记录')}><Star size={14}/>收藏</button><button className="text-button" disabled={busy} onClick={() => void batchPatch({ pinned: true }, '已置顶所选记录')}><Pin size={14}/>置顶</button><button className="text-button" disabled={busy} title="按选择顺序逐条复制，适合连续填写多个字段" onClick={() => void startSequence()}><Play size={14}/>序列粘贴</button><label className="bulk-collection"><Folder size={14}/><select aria-label="加入集合" value="" disabled={busy} onChange={e => { if(e.target.value) void batchAdd(e.target.value) }}><option value="">加入集合…</option>{collections.map(name => <option key={name}>{name}</option>)}</select><ChevronDown size={12}/></label><button className="text-button danger" disabled={busy} onClick={() => setBulkDelete(true)}><Trash2 size={14}/>删除</button><button className="text-button" onClick={() => setChecked(new Set())}><X size={14}/>取消选择</button></div></div>}
        {sequence?.active && <div className="sequence-bar" role="status"><div className="sequence-info"><Play size={15}/><div><strong>序列粘贴 {sequence.position}/{sequence.total}</strong><span>当前：{sequence.currentTitle ?? '未命名记录'} · 剩余 {sequence.remaining} 条 · 按 {settings?.shortcut ?? 'Ctrl+Shift+V'} 粘贴下一项</span></div></div><div className="sequence-actions"><button className="secondary-button" title="仅复制下一项，不发送粘贴快捷键" disabled={busy} onClick={() => void nextSequence()}><Copy size={14}/>下一项</button><button className="text-button" disabled={busy} onClick={() => void stopSequence()}>结束</button></div></div>}
        <div className="clip-list" onKeyDown={e => { if((e.target as HTMLElement).tagName === 'SELECT') return; if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setChecked(new Set(visible.map(c => c.id))); return } if(e.key === 'Escape' && checked.size) { e.preventDefault(); setChecked(new Set()); return } if(e.key === 'Enter') { e.preventDefault(); document.querySelector<HTMLElement>('.detail-pane')?.focus() } if(e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = visible.findIndex(c => c.id === summary?.id), next = Math.max(0, Math.min(visible.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))); if(visible[next]) { setSelectedId(visible[next].id); e.currentTarget.querySelectorAll<HTMLButtonElement>('.clip-row')[next]?.focus() } } }}>
          {(loading || mainSearch.loading) && <div className="list-empty" role="status">{loading ? '正在读取记录…' : '正在搜索…'}</div>}
          {!loading && !mainSearch.loading && visible.length === 0 && <div className="list-empty"><Search size={27}/><strong>{clips.length === 0 && !query ? '复制一段内容，从这里开始' : '没有找到相关记录'}</strong><span>{native && clips.length === 0 ? '文本、链接、图片与文件会自动出现在这里' : '试试其他关键词或内容类型'}</span>{(query || kind !== 'all' || sourceFilter !== 'all') && <button className="text-button" onClick={() => { setQuery(''); setKind('all'); setSourceFilter('all') }}>清除筛选</button>}</div>}
          {visible.map((c, i) => <div key={c.id}>{(i === 0 || dayOf(visible[i - 1]) !== dayOf(c)) && <div className="date-group">{dayOf(c)}<span>{new Date(c.capturedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span></div>}<button className={`clip-row ${summary?.id === c.id ? 'row-selected' : ''} ${checked.has(c.id) ? 'row-checked' : ''}`} onClick={e => selectRow(c, e)} onMouseDown={e => { if(e.shiftKey) e.preventDefault() }} aria-pressed={checked.has(c.id)}><span className={`row-check ${checked.has(c.id) ? 'is-checked' : ''}`} aria-hidden="true">{checked.has(c.id) && <Check size={12}/>}</span>{c.type === 'image' || imageFile(c) ? <Thumb clip={c}/> : <div className={`type-tile type-${c.type}`}><TypeIcon type={c.type}/></div>}<div className="clip-row-text"><div className="clip-row-title">{c.title || '未命名记录'}</div><p>{c.type === 'image' ? native ? '图片' : '图片 · 设计示例' : c.type === 'file' ? fileSummary(c.content, c.fileSize) : c.content.replace(/\n/g, ' ')}</p><div className="row-meta"><span className="source-dot source-other"/>{c.source}<span className="row-time">{c.time}</span></div></div>{(c.pinned || c.favorite) && <span className="row-badges">{c.pinned && <Pin size={12} fill="currentColor"/>}{c.favorite && <Star size={12} fill="currentColor"/>}</span>}</button></div>)}
        </div><div className="list-footer"><span>{paused ? '已暂停采集' : native ? '所有内容仅保存在本地' : '虚构数据 · 刷新重置'}</span><Monitor size={14}/></div>
      </section>
      <section className="detail-pane" aria-label="记录详情" tabIndex={-1}>
        {selected ? <><div className="detail-toolbar"><span><TypeIcon type={selected.type} size={15}/>{typeNames[selected.type]}预览</span><div>{!selected.deleted && <><IconButton label={selected.pinned ? '取消置顶' : '置顶记录'} active={selected.pinned} disabled={busy} onClick={() => void update(selected.id, { pinned: !selected.pinned })}>{selected.pinned ? <PinOff size={18}/> : <Pin size={18}/>}</IconButton><IconButton label={selected.favorite ? '取消收藏' : '收藏记录'} active={selected.favorite} disabled={busy} onClick={() => void update(selected.id, { favorite: !selected.favorite })}><Star size={18} fill={selected.favorite ? 'currentColor' : 'none'}/></IconButton></>}{selected.deleted ? <IconButton label="恢复记录" disabled={busy} onClick={() => void restore(selected.id)}><RotateCcw size={18}/></IconButton> : <IconButton label="删除记录" disabled={busy} onClick={() => { void update(selected.id, { deleted: true }).then(ok => { if(ok) notice('已移到最近删除') }) }}><Trash2 size={18}/></IconButton>}</div></div>
        <div className="detail-scroll"><div className="detail-content"><div className={`type-tile detail-type type-${selected.type}`}><TypeIcon type={selected.type} size={26}/></div><div className="detail-title-row"><h2>{selected.title || '未命名记录'}</h2>{selected.favorite && <span className="favorite-badge"><Star size={12} fill="currentColor"/>已收藏</span>}</div><div className="detail-subtitle">来自 {selected.source}<span>·</span>{dayOf(selected)} {selected.time}</div>
        {selected.type === 'image' ? <Picture key={selected.id} clip={selected}/> : !detail ? <div className="text-preview"><pre>{detailError ? '内容读取失败，请重新加载。' : '正在读取完整内容…'}</pre></div> : selected.type === 'link' ? <div className="link-preview"><div className="link-site-icon"><Link2 size={25}/></div><div><strong>{selected.title}</strong><span>{hostname(selected.content)}</span></div><IconButton label="在浏览器打开链接" onClick={() => void openLink(selected)}><ArrowUpRight size={20}/></IconButton></div> : selected.type === 'file' ? <div className="file-preview"><div className="preview-label">文件与文件夹<span>{fileEntries(selected).length} 项{selected.fileSize > 0 ? ` · ${formatBytes(selected.fileSize)}` : ''}</span></div>{imageFile(selected) && <Picture key={`${selected.id}-file`} clip={selected}/>}{selected.fileSize >= FILE_WARN && <div className="file-warning" role="status"><AlertCircle size={15}/><span>总大小达到 1 GB。复制记录只写入路径；粘贴时由目标应用实际复制，可能耗时并占用磁盘。</span></div>}<div className="file-rows">{fileEntries(selected).map((entry, i) => <div className="file-row" key={`${i}-${entry.path}`}><FolderOpen size={17}/><div><strong>{baseName(entry.path)}</strong><span>{entry.path}</span><em>{entry.isDir ? '文件夹' : entry.size === null ? '大小未知' : formatBytes(entry.size)}{entry.modifiedAt !== null ? ` · ${formatModified(entry.modifiedAt)}` : ''}</em></div></div>)}</div></div> : <div className={`text-preview ${selected.content.startsWith('import ') ? 'code-preview' : ''}`}><div className="preview-label">{selected.content.startsWith('import ') ? '代码 / 纯文本' : '纯文本'}<span>{[...selected.content].length} 字符</span></div><pre>{selected.content}</pre></div>}
        <div className="primary-actions">{selected.deleted ? <><button disabled={busy} className="primary-button" onClick={() => void restore(selected.id)}><RotateCcw size={16}/>恢复记录</button><button disabled={busy} className="danger-button" onClick={() => setConfirmDelete(selected.id)}>彻底删除</button></> : <><button disabled={copying} className="primary-button" onClick={() => void copy(selected)}><Copy size={16}/>{copying ? '正在复制…' : selected.type === 'file' ? '复制文件' : '复制内容'}</button>{selected.type === 'link' && <button className="secondary-button" onClick={() => void openLink(selected)}>打开链接<ArrowUpRight size={15}/></button>}{(selected.type === 'text' || selected.type === 'link') && <div className="copy-menu-wrap"><button className="secondary-button" aria-haspopup="menu" aria-expanded={copyMenu} onClick={() => setCopyMenu(value => !value)}>复制为<ChevronDown size={14}/></button>{copyMenu && <><div className="copy-menu-backdrop" onClick={() => setCopyMenu(false)}/><div className="copy-menu" role="menu">{selected.hasHtml && <button role="menuitem" onClick={() => void copyFormat(selected, 'html')}>HTML 格式<small>保留粗体、链接与排版</small></button>}{selected.hasRtf && <button role="menuitem" onClick={() => void copyFormat(selected, 'rtf')}>RTF 格式<small>适合粘贴到 Word 等编辑器</small></button>}<button role="menuitem" onClick={() => void copyVariant(selected, 'plain')}>纯文本<small>按原样写入剪贴板</small></button><button role="menuitem" onClick={() => void copyVariant(selected, 'trim')}>去除首尾空白<small>适合粘贴到表单或搜索框</small></button><button role="menuitem" onClick={() => void copyVariant(selected, 'one_line')}>合并为单行<small>换行替换为空格</small></button></div></>}</div>}<span className="action-hint">{selected.type === 'file' ? '粘贴到资源管理器或其他应用' : '随时找回，再次使用'}</span></>}</div>
        <div className="info-section"><h3>记录信息</h3><div className="info-row"><span>名称</span><Editable key={`title-${selected.id}`} cache={drafts.current} cacheKey={`title-${selected.id}`} label="记录名称" value={selected.title} maxLength={200} disabled={selected.deleted} save={value => update(selected.id, { title: value })}/></div><div className="info-row"><span>来源应用</span><div><span className="source-dot source-other"/>{selected.source}{selected.source !== '未知来源' && <button className="text-button exclude-link" disabled={busy || selected.deleted} title={`不再记录来自 ${selected.source} 的内容`} onClick={() => void excludeApp(selected.source)}><ShieldOff size={12}/>排除此应用</button>}</div></div><div className="info-row"><span>复制时间</span><div>{new Date(selected.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div></div>{(selected.type === 'text' || selected.type === 'link') && <div className="info-row"><span>保存格式</span><div className="format-badges"><span>纯文本</span>{selected.hasHtml && <span>HTML</span>}{selected.hasRtf && <span>RTF</span>}</div></div>}{selected.type === 'file' && <><div className="info-row"><span>总大小</span><div>{selected.fileSize > 0 ? formatBytes(selected.fileSize) : '未知或空文件夹'}</div></div><div className="info-row"><span>最近修改</span><div>{formatModified(selected.fileModifiedAt)}</div></div></>}<div className="info-row collections-row"><span>所属集合</span><div>{selected.collections.map(name => <button disabled={selected.deleted || busy} className="collection-chip" key={name} title={`从${name}移除`} onClick={() => void update(selected.id, { collections: selected.collections.filter(n => n !== name) })}><Folder size={12}/>{name}<X size={11}/></button>)}{!selected.deleted && <select disabled={busy} aria-label="加入集合" value="" onChange={e => { if(e.target.value) void update(selected.id, { collections: [...selected.collections, e.target.value] }) }}><option value="">＋ 加入集合</option>{collections.filter(name => !selected.collections.includes(name)).map(name => <option key={name}>{name}</option>)}</select>}</div></div></div>
        <div className="note-section"><h3>备注<span>{busy ? '正在保存…' : '失焦后自动保存'}</span></h3><Editable key={`note-${selected.id}`} cache={drafts.current} cacheKey={`note-${selected.id}`} label="备注" value={selected.note} multiline maxLength={10000} disabled={selected.deleted} save={value => update(selected.id, { note: value })}/></div></div></div>
        <div className="detail-footer"><ShieldCheck size={14}/><span>{native ? '这条记录只属于你，保存在你的设备上。' : '浏览器演示使用虚构内容。'}</span><kbd>MyPaste</kbd></div></> : <div className="detail-empty"><div className="empty-illustration"><Clipboard size={44}/></div><h2>留一点空间，给下一次灵感</h2><p>{loading ? '正在连接本地数据…' : '选择一条记录，在这里查看完整内容。'}</p></div>}
      </section></div>
    </main>
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
    {modal === 'collection' && <Modal title="新建集合" onClose={() => void closeModal()}><form onSubmit={e => { e.preventDefault(); const name = collectionName.trim(); if(!name) return; void run(() => service.createCollection(name)).then(ok => { if(ok) { setCollectionName(''); setModal(null); go(name) } }) }}><label className="field-label">集合名称<input maxLength={80} placeholder="例如：写作素材" value={collectionName} onChange={e => setCollectionName(e.target.value)}/></label><p className="form-help">把经常一起使用的内容放在一起。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => void closeModal()}>取消</button><button className="primary-button" disabled={busy || !collectionName.trim()}>创建集合</button></div></form></Modal>}
    {modal === 'settings' && <Modal title="设置" onClose={() => void closeModal()} className="settings-modal"><div className="settings-tabs">{['通用','历史保留','数据','隐私'].map(t => <button key={t} className={settingsTab === t ? 'active' : ''} onClick={() => setSettingsTab(t)}>{t}</button>)}</div><div className="settings-body">
      {settingsTab === '通用' ? <><div className="settings-intro"><Keyboard size={23}/><h3>让工作少一点打断</h3><p>随时呼出，快速找回复制过的内容。</p></div><div className="setting-row"><div>快捷呼出<small>{native ? status?.shortcutRegistered ? '全局快捷键已注册' : status?.shortcutError ?? '尚未注册' : '浏览器仅在当前页面使用'}</small></div><div className="shortcut-editor"><input aria-label="全局快捷键" value={shortcutDraft} maxLength={80} onChange={e => setShortcutDraft(e.target.value)}/><button disabled={!native || busy || !shortcutDraft.trim()} className="secondary-button" onClick={() => void run(() => service.settings({ shortcut: shortcutDraft.trim() })).then(ok => { if(ok) notice('快捷键已更新') })}>保存</button></div></div><div className="setting-row"><div>暂停记录<small>{native ? '重启后保持暂停状态' : '此处仅演示状态切换'}</small></div><button disabled={busy || !snapshot} role="switch" aria-checked={paused} aria-label="暂停记录" className={`switch ${paused ? 'on' : ''}`} onClick={() => void togglePaused()}><span/></button></div><div className="setting-row"><div>开机自动启动<small>{native ? '登录 Windows 后自动在托盘运行' : '仅在桌面版可用'}</small></div><button role="switch" aria-checked={status?.autostart ?? false} aria-label="开机自动启动" className={`switch ${status?.autostart ? 'on' : ''}`} disabled={!native || busy} onClick={() => void toggleAutostart()}><span/></button></div><div className="setting-row"><div>管理员启动<small>{native ? status?.elevated ? '当前已以管理员身份运行；可粘贴到以管理员身份运行的应用' : '普通权限。部分以管理员身份运行的应用需要提权后才能粘贴' : '仅在桌面版可用'}</small></div><button className="secondary-button" disabled={!native || busy || status?.elevated} onClick={() => setPendingElevated(true)}>{status?.elevated ? '已提权' : '以管理员身份重启…'}</button></div><div className="setting-row"><div>软件更新<small>当前版本 {appVersion || '读取中…'}{!native ? ' · 浏览器演示不检查更新' : ''}</small>{updateState === 'latest' && <small role="status">已是最新版本</small>}{updateInfo && <small role="status">发现新版本 {updateInfo.version}{updateInfo.notes ? `：${updateInfo.notes}` : '，包含修复与改进'}</small>}{updateState === 'downloading' && <small role="status">正在下载{updateProgress?.total ? ` ${Math.min(100, Math.round(updateProgress.downloaded / updateProgress.total * 100))}%` : updateProgress ? ` ${formatBytes(updateProgress.downloaded)}` : '…'}</small>}{updateError && <small className="setting-error" role="alert">{updateError}</small>}</div>{updateInfo ? <button className="secondary-button" disabled={updateState === 'downloading'} onClick={() => void installUpdate()}>{updateState === 'downloading' ? '正在安装…' : '下载并安装'}</button> : <button className="secondary-button" disabled={!native || updateState === 'checking'} onClick={() => void checkUpdates()}>{updateState === 'checking' ? '正在检查…' : '检查更新'}</button>}</div><div className="settings-notice">{native ? '关闭主窗口后仍在托盘运行。请从托盘菜单退出。快捷键被占用时，可以更换组合。' : '这是浏览器演示。使用桌面版体验真实监听、托盘和全局快捷键。'}</div></> : settingsTab === '历史保留' ? <><h3>给常用内容多留一点时间</h3><p className="form-help">收藏与置顶不参与时间和条数清理。删除内容在回收站保留 7 天。</p><div className="setting-row"><div>普通记录保留时间</div><select disabled={busy || !settings} aria-label="保留天数" value={settings?.retentionDays ?? 30} onChange={e => void run(() => service.settings({ retentionDays: Number(e.target.value) }))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></div><div className="setting-row"><div>最大普通历史条数</div><select disabled={busy || !settings} aria-label="历史条数" value={settings?.maxItems ?? 500} onChange={e => void run(() => service.settings({ maxItems: Number(e.target.value) }))}><option value={500}>500 条</option><option value={1000}>1,000 条</option><option value={5000}>5,000 条</option></select></div><div className="settings-notice">{native ? '设置保存在本机，到期和超量记录进入回收站。' : '演示选择仅保留在当前页面，不执行清理。'}图片单张最多 10 MiB，总计 500 MiB。可在「管理集合」中为单个集合设置更长的保留时间或独立条数上限；记录只要仍被任一集合保留，就不会被清理。</div></> : settingsTab === '数据' ? <><div className="settings-intro"><Database size={23}/><h3>数据放在你选择的位置</h3><p>备份包含全部记录与图片；设置只保留在本机。</p></div>{snapshot?.storageError && <p className="setting-error" role="alert">存储迁移未完成：{snapshot.storageError}（仍使用原路径）</p>}<div className="setting-row"><div>本地存储位置<small className="data-path">{native ? `${snapshot?.dataDir || '正在读取目录…'}${status?.portable ? '（便携模式）' : ''}` : '浏览器演示不写入磁盘'}</small></div><div className="data-actions"><button className="secondary-button" disabled={!native || busy} onClick={() => void openDataDir()}>打开文件夹</button><button className="secondary-button" disabled={!native || busy} onClick={() => void chooseDataDir()}>更改…</button></div></div><div className="setting-row"><div>备份与恢复<small>导出单个 .sqlite3 文件；恢复会替换当前全部记录，设置保留。</small></div><div className="data-actions"><button className="secondary-button" disabled={!native || busy || !snapshot} onClick={() => void exportBackup()}>导出备份</button><button className="secondary-button" disabled={!native || busy || !snapshot} onClick={() => void pickRestore()}>从备份恢复…</button></div></div><div className="setting-row"><div>数据库占用<small>{usage ? `${usage.bytes > 0 ? `${formatBytes(usage.bytes)} · ` : ''}${usage.items} 条记录，回收站 ${usage.trashed} 条${native ? '' : '（演示）'}` : native ? '正在读取…' : '浏览器演示不写入磁盘'}</small></div><button className="secondary-button" disabled={!native || busy || compacting} onClick={() => void compact()}>{compacting ? '正在整理…' : '整理数据库'}</button></div><div className="setting-row"><div>诊断日志<small className="data-path">{native ? logInfo ? `${logInfo.file || 'logs/mypaste.log'}${logInfo.bytes ? ` · ${formatBytes(logInfo.bytes)}` : ''}` : '正在读取…' : '浏览器演示不写入日志'}</small><small>只记录操作与错误，不记录剪贴板内容、搜索词或窗口标题；达到 1 MiB 后轮换，保留最近 3 个。</small></div><div className="data-actions"><button className="secondary-button" disabled={!native} onClick={() => void openLogDir()}>打开日志目录</button><button className="secondary-button" disabled={!native || busy} onClick={() => void exportDiagnostics()}>导出诊断信息…</button></div></div><div className="settings-notice">更改位置后应用会重启，并把 history.sqlite3 迁移到新目录，复制成功后才删除旧文件。备份文件未加密，请妥善保管。</div></> : <><div className="settings-intro"><ShieldCheck size={25}/><h3>你的剪贴板，留在你的设备</h3><p>无需账号，默认不上传剪贴内容。</p></div><div className="exclude-block"><h4>不记录这些应用的内容</h4><p className="form-help">切换窗口时，来自这些应用的复制内容会在读取前被跳过，不会写入历史。</p><form className="exclude-add" onSubmit={e => { e.preventDefault(); const name = appDraft; void excludeApp(name).then(() => setAppDraft('')) }}><input aria-label="排除的应用名称" maxLength={120} placeholder="应用名，例如 KeePassXC" value={appDraft} onChange={e => setAppDraft(e.target.value)}/><button className="secondary-button" disabled={busy || !appDraft.trim()}>添加</button></form>{(settings?.excludedApps.length ?? 0) > 0 ? <div className="exclude-list">{settings!.excludedApps.map(name => <span className="exclude-chip" key={name}><ShieldOff size={12}/>{name}<button aria-label={`恢复记录来自 ${name} 的内容`} disabled={busy} onClick={() => void removeExcluded(name)}><X size={11}/></button></span>)}</div> : <p className="empty-inline">尚未排除任何应用。</p>}</div><div className="settings-notice">本地存储不等同于加密保险箱。排除规则在读取剪贴板前生效；来源识别失败时无法匹配，因此不能承诺拦截所有敏感内容。处理密码或密钥前，仍建议暂停记录。</div></>}
    </div><div className="modal-actions"><button className="primary-button" onClick={() => void closeModal()}>完成</button></div></Modal>}
    {modal === 'quick' && <Modal title="快捷窗口" onClose={() => void closeModal()} className="quick-modal" drag={quickOnly}><div className="quick-brand"><div className="brand-icon"><img src={mypasteMark} alt=""/></div><strong>找回刚才的内容</strong></div><div className="quick-search"><Search size={21}/><input role="combobox" aria-expanded="true" aria-controls="quick-results" aria-activedescendant={quickSelected ? `quick-${quickSelected.id}` : undefined} aria-label="快捷搜索" maxLength={1000} placeholder="搜索文字、链接、灵感…" value={quickQuery} onChange={e => { setQuickQuery(e.target.value); setQuickIndex(0) }} onKeyDown={e => { if(e.key === 'ArrowDown') { e.preventDefault(); setQuickIndex(i => Math.min(i + 1, Math.max(0, quickItems.length - 1))) } if(e.key === 'ArrowUp') { e.preventDefault(); setQuickIndex(i => Math.max(0, i - 1)) } if(e.key === 'Enter' && quickSelected) { e.preventDefault(); void copy(quickSelected, true, e.ctrlKey) } }}/><kbd>Esc</kbd></div><div className="quick-filters" role="group" aria-label="快捷筛选"><div className="quick-chips">{(['all','text','link','image','file'] as const).map(t => <button key={t} className={`quick-chip ${quickKind === t ? 'active' : ''}`} aria-pressed={quickKind === t} onClick={() => { setQuickKind(t); setQuickIndex(0) }}>{t === 'all' ? '全部' : typeNames[t]}</button>)}</div><button className="quick-sort" title="切换排序方式" onClick={() => { setQuickSort(s => s === 'recent' ? 'used' : 'recent'); setQuickIndex(0) }}>{quickSort === 'recent' ? '最近复制' : '最常使用'}{quickSort === 'recent' ? <ArrowDown size={12}/> : <Zap size={12}/>}</button><label className="quick-select"><Folder size={13}/><select aria-label="集合筛选" value={quickCollection} onChange={e => { setQuickCollection(e.target.value); setQuickIndex(0) }}><option value="all">所有集合</option>{collections.map(name => <option key={name} value={name}>{name}</option>)}</select><ChevronDown size={12}/></label></div>{quickNotice && <div className="quick-notice" role="status"><AlertCircle size={14}/><span>{quickNotice}</span></div>}<div className="quick-results" id="quick-results" role="listbox" aria-label="快捷搜索结果"><div className="date-group">{quickQuery ? '搜索结果' : quickSort === 'used' ? '最常使用' : '最近复制'}<span>{quickItems.length} 条</span></div>{quickItems.length === 0 && <div className="list-empty">{quickSearch.loading ? '正在搜索…' : '没有找到相关记录'}{!quickSearch.loading && (quickKind !== 'all' || quickCollection !== 'all') && <button className="text-button" onClick={() => { setQuickKind('all'); setQuickCollection('all') }}>清除筛选</button>}</div>}{quickItems.map((c, i) => <button disabled={copying} id={`quick-${c.id}`} role="option" aria-selected={quickSelected?.id === c.id} key={c.id} className={`quick-row ${quickSelected?.id === c.id ? 'active' : ''}`} onFocus={() => setQuickIndex(i)} onClick={() => { setQuickIndex(i); void copy(c, true) }}>{c.type === 'image' || imageFile(c) ? <Thumb clip={c}/> : <div className={`type-tile type-${c.type}`}><TypeIcon type={c.type}/></div>}<div><strong>{c.pinned && <Pin className="quick-pin" size={11} fill="currentColor"/>}{c.title || '未命名记录'}</strong><span>{c.type === 'image' ? '图片' : c.type === 'file' ? fileSummary(c.content, c.fileSize) : c.content.replace(/\n/g,' ')}</span></div>{quickSelected?.id === c.id && <kbd>↵ 复制</kbd>}</button>)}</div><div className="quick-footer"><span><ArrowUp size={12}/><ArrowDown size={12}/>选择<kbd>↵</kbd>复制<kbd>Ctrl ↵</kbd>粘贴</span><span><Zap size={13}/>{native ? '本地剪贴板' : '浏览器演示'}</span></div></Modal>}
    {deletionTarget && <Modal title="彻底删除这条记录？" onClose={() => setConfirmDelete(null)}><p className="form-help">“{deletionTarget.title}”将从{native ? '本机数据库' : '当前演示'}移除，无法恢复。</p><div className="modal-actions"><button className="secondary-button" onClick={() => setConfirmDelete(null)}>取消</button><button disabled={busy} className="danger-button" onClick={() => void run(() => service.purge(deletionTarget.id)).then(ok => { if(ok) { setConfirmDelete(null); notice('记录已彻底删除') } })}>彻底删除</button></div></Modal>}
    {pendingRestore && <Modal title="从备份恢复？" onClose={() => setPendingRestore(null)}><p className="form-help">当前全部记录会被备份中的内容替换，应用设置保持不变。此操作无法撤销。</p><p className="form-help data-path">{pendingRestore}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setPendingRestore(null)}>取消</button><button disabled={busy} className="danger-button" onClick={() => void restoreBackup()}>恢复</button></div></Modal>}
    {pendingDataDir && <Modal title="迁移存储位置？" onClose={() => setPendingDataDir(null)}><p className="form-help">应用会重启，并把现有数据迁移到：</p><p className="form-help data-path">{pendingDataDir}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setPendingDataDir(null)}>取消</button><button disabled={busy} className="primary-button" onClick={() => void moveDataDir()}>迁移并重启</button></div></Modal>}
    {pendingElevated && <Modal title="以管理员身份重启？" onClose={() => setPendingElevated(false)}><p className="form-help">MyPaste 会请求 Windows 管理员权限并在成功后重新启动。若在提权提示中取消，应用会继续以当前权限运行。</p><div className="modal-actions"><button className="secondary-button" onClick={() => setPendingElevated(false)}>取消</button><button className="primary-button" disabled={busy} onClick={() => void restartElevated()}>重启并提权</button></div></Modal>}
    {bulkDelete && checked.size > 0 && <Modal title={`删除所选的 ${checked.size} 条记录？`} onClose={() => setBulkDelete(false)}><p className="form-help">所选记录会移入最近删除，7 天后自动清理。</p><div className="modal-actions"><button className="secondary-button" onClick={() => setBulkDelete(false)}>取消</button><button disabled={busy} className="danger-button" onClick={() => void batchDelete()}>移到最近删除</button></div></Modal>}
    {manageCollections && <Modal title="管理集合" onClose={() => { setManageCollections(false); setRenameTarget(''); setDeleteCollectionTarget('') }} className="collection-modal">
      {collections.length === 0 ? <p className="empty-inline">还没有集合。先新建一个，再把常用内容放进去。</p> : <div className="collection-list">{collections.map((name, i) => <div className="collection-row" key={name}>
        {renameTarget === name ? <form className="collection-rename" onSubmit={e => { e.preventDefault(); void commitRename() }}><input aria-label={`重命名 ${name}`} value={renameDraft} maxLength={80} onChange={e => setRenameDraft(e.target.value)}/><button className="secondary-button" disabled={busy || !renameDraft.trim()}>保存</button><button type="button" className="secondary-button" onClick={() => setRenameTarget('')}>取消</button></form>
        : deleteCollectionTarget === name ? <div className="collection-confirm" role="alert"><span>删除「{name}」？其中的记录会保留。</span><div><button className="text-button" onClick={() => setDeleteCollectionTarget('')}>取消</button><button className="text-button danger" disabled={busy} onClick={() => void removeCollection(name)}>删除集合</button></div></div>
        : <><span className="collection-name"><Folder size={16}/>{name}<small>{active.filter(c => c.collections.includes(name)).length} 条</small></span><div className="collection-policy"><label>保留<select aria-label={`${name} 保留时间`} disabled={busy} value={policyFor(name).retentionDays ?? ''} onChange={e => void savePolicy(name, e.target.value === '' ? null : Number(e.target.value), policyFor(name).maxItems)}><option value="">跟随全局</option><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>1 年</option></select><ChevronDown size={11}/></label><label>上限<select aria-label={`${name} 条数上限`} disabled={busy} value={policyFor(name).maxItems ?? ''} onChange={e => void savePolicy(name, policyFor(name).retentionDays, e.target.value === '' ? null : Number(e.target.value))}><option value="">跟随全局</option><option value={100}>100 条</option><option value={500}>500 条</option><option value={1000}>1,000 条</option><option value={5000}>5,000 条</option></select><ChevronDown size={11}/></label></div><div className="collection-actions"><IconButton label={`上移 ${name}`} disabled={busy || i === 0} onClick={() => void moveCollection(name, 'up')}><ArrowUp size={15}/></IconButton><IconButton label={`下移 ${name}`} disabled={busy || i === collections.length - 1} onClick={() => void moveCollection(name, 'down')}><ArrowDown size={15}/></IconButton><button className="text-button" disabled={busy} onClick={() => startRename(name)}>重命名</button><button className="text-button danger" disabled={busy} onClick={() => setDeleteCollectionTarget(name)}>删除</button></div></>}
      </div>)}</div>}
      <p className="form-help">删除集合不会删除其中的记录。排序会同步到侧栏。集合的保留时间与条数上限只作用于该集合；收藏与置顶始终保留。</p>
      <div className="modal-actions"><button className="primary-button" onClick={() => { setManageCollections(false); setRenameTarget(''); setDeleteCollectionTarget('') }}>完成</button></div>
    </Modal>}
  </div>
}
