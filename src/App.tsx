import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clipboard, Search, Star, FileText, Link2, Image, Folder, FolderOpen, Plus, ChevronDown, ChevronRight, Settings, Pause, Play, Trash2, Copy, X, Check, ArrowUpRight, Keyboard, ShieldCheck, ShieldOff, PanelLeftClose, SlidersHorizontal, RotateCcw, Zap, MoreHorizontal, Monitor, ArrowDown, ArrowUp, AlertCircle } from 'lucide-react'
import { clipboardService as service, errorMessage, native, type Clip, type ClipPatch, type FileEntry, type Kind, type UpdateCheck, type UpdateProgress } from './clipboard-service'
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
function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
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
  return <div className="modal-backdrop" onMouseDown={e => { if(e.target === e.currentTarget) onClose() }}><div ref={ref} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-title"><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={19}/></IconButton></div>{children}</div></div>
}

export default function App() {
  const [nav, setNav] = useState('全部记录'), [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [sourceFilter, setSourceFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<number>(), [modal, setModal] = useState<'settings' | 'quick' | 'collection' | null>(null)
  const [collectionName, setCollectionName] = useState(''), [toast, setToast] = useState(''), [quickQuery, setQuickQuery] = useState(''), [quickIndex, setQuickIndex] = useState(0)
  const [settingsTab, setSettingsTab] = useState('通用'), [shortcutDraft, setShortcutDraft] = useState('Ctrl+Shift+V'), [appDraft, setAppDraft] = useState('')
  const [quickKind, setQuickKind] = useState<'all' | Kind>('all'), [quickCollection, setQuickCollection] = useState('all'), [quickSort, setQuickSort] = useState<'recent' | 'used'>('recent'), [quickNotice, setQuickNotice] = useState('')
  const [appVersion, setAppVersion] = useState(''), [updateState, setUpdateState] = useState<'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'error'>('idle')
  const [updateInfo, setUpdateInfo] = useState<UpdateCheck | null>(null), [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null), [updateError, setUpdateError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null), [sidebarOpen, setSidebarOpen] = useState(false), [copying, setCopying] = useState(false)
  const drafts = useRef<DraftStore>(new Map())
  const desktopQuick = useRef(false), quickSession = useRef(0), searchRef = useRef<HTMLInputElement>(null)
  const { snapshot, loading, busy, error, revision, run, refresh, dismissError } = useClipboard(() => { quickSession.current++; desktopQuick.current = true; setConfirmDelete(null); setQuickQuery(''); setQuickIndex(0); setQuickNotice(''); setModal('quick') })
  const clips = snapshot?.items ?? [], collections = snapshot?.collections ?? [], settings = snapshot?.settings, status = snapshot?.status, paused = settings?.paused ?? false
  const mainSearch = useSearchIds(query, revision), quickSearch = useSearchIds(quickQuery, revision)
  const active = clips.filter(c => !c.deleted)
  const sources = [...new Set(clips.filter(c => c.deleted === (nav === '最近删除')).map(c => c.source).filter(Boolean))]
  const visible = clips.filter(c => c.deleted === (nav === '最近删除') && (nav !== '收藏' || c.favorite) && (!['text','link','image','file'].includes(nav) || c.type === nav) && (!collections.includes(nav) || c.collections.includes(nav)) && (kind === 'all' || c.type === kind) && (sourceFilter === 'all' || c.source === sourceFilter) && (!mainSearch.ids || mainSearch.ids.has(c.id)))
  const summary = visible.find(c => c.id === selectedId) ?? visible[0]
  const { detail, error: detailError } = useClipDetail(summary?.id, revision)
  const selected = detail ?? summary, heading = Object.hasOwn(typeNames, nav) ? typeNames[nav as Kind] : nav
  const quickMatches = active.filter(c => (quickKind === 'all' || c.type === quickKind) && (quickCollection === 'all' || c.collections.includes(quickCollection)) && (!quickSearch.ids || quickSearch.ids.has(c.id)))
  const quickItems = [...quickMatches].sort((a, b) => quickSort === 'used' ? (b.useCount - a.useCount || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.capturedAt - a.capturedAt) : b.capturedAt - a.capturedAt)
  const quickSelected = quickItems[Math.min(quickIndex, Math.max(0, quickItems.length - 1))]
  const deletionTarget = clips.find(c => c.id === confirmDelete)
  const notice = (text: string) => setToast(text)
  useEffect(() => { if(!toast) return; const id = setTimeout(() => setToast(''), 5000); return () => clearTimeout(id) }, [toast])
  useEffect(() => { if(settings) setShortcutDraft(settings.shortcut) }, [settings?.shortcut])
  useEffect(() => { void service.version().then(setAppVersion).catch(() => setAppVersion('')) }, [])
  useEffect(() => { if(modal === 'quick') document.getElementById(`quick-${quickSelected?.id}`)?.scrollIntoView({ block: 'nearest' }) }, [modal, quickSelected?.id])
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
  function go(value: string) { setNav(value); setQuery(''); setKind('all'); setSourceFilter('all'); setSelectedId(undefined); setSidebarOpen(false) }
  function navButton(value: string, icon: ReactNode, count?: number) { return <button className={`nav-item ${nav === value ? 'selected' : ''}`} onClick={() => go(value)}>{icon}<span>{Object.hasOwn(typeNames, value) ? typeNames[value as Kind] : value}</span>{count !== undefined && <small>{count}</small>}</button> }
  async function restore(id: number) { if(await update(id, { deleted: false })) notice('记录已恢复') }
  const banner = error || mainSearch.error || quickSearch.error || detailError
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <div className="brand"><div className="brand-icon"><Clipboard size={23}/></div><div>MyPaste<span>你的随身剪贴板</span></div><IconButton label="收起侧栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17}/></IconButton></div>
      <div className="workspace"><div className="workspace-avatar">M</div><div>个人空间<small>{native ? '仅保存在这台设备' : '浏览器演示 · 刷新重置'}</small></div><ShieldCheck size={17}/></div>
      <div className="nav-group">{navButton('全部记录', <Clipboard size={18}/>, active.length)}{navButton('收藏', <Star size={18}/>, active.filter(c => c.favorite).length)}</div><div className="section-label">内容类型</div>
      <div className="nav-group">{(['text','link','image','file'] as Kind[]).map(type => <div key={type}>{navButton(type, <TypeIcon type={type} size={18}/>, active.filter(c => c.type === type).length)}</div>)}</div>
      <div className="section-label">我的集合<IconButton label="新建集合" disabled={!snapshot} onClick={() => setModal('collection')}><Plus size={16}/></IconButton></div>
      <div className="nav-group">{collections.map((name, i) => <button key={name} className={`nav-item ${nav === name ? 'selected' : ''}`} onClick={() => go(name)}><Folder size={18} className={`folder-color-${i % 3}`}/><span>{name}</span></button>)}</div>
      <div className="sidebar-bottom">{navButton('最近删除', <Trash2 size={18}/>)}<div className="sidebar-divider"/><button disabled={!snapshot || busy} className="capture-state" onClick={() => void togglePaused()}><span className={`status-dot ${paused || status?.captureState === 'error' ? 'paused' : ''}`}/><span>{!snapshot ? '正在连接本地服务' : paused ? '记录已暂停' : status?.captureState === 'error' ? '记录服务异常' : native ? '正在记录剪贴板' : '演示记录状态'}<small>{native ? status?.captureError ?? (paused ? '点击恢复记录' : '后台监听已连接') : '浏览器不监听剪贴板'}</small></span>{paused ? <Play size={15}/> : <Pause size={15}/>}</button><button className="nav-item" onClick={() => setModal('settings')}><Settings size={18}/><span>设置</span></button><div className="local-label"><ShieldCheck size={13}/>本地优先，安心留存</div></div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><button className="mobile-menu icon-button" aria-label="打开导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Clipboard size={19}/></button><div className="breadcrumb">个人空间<ChevronRight size={14}/><strong>{heading}</strong></div><div className="topbar-right"><span className="prototype-badge">{native ? '本地模式' : '浏览器演示'}</span><button className="quiet-button" onClick={openQuick}><Keyboard size={16}/>快捷窗口<kbd>{settings?.shortcut ?? 'Ctrl+Shift+V'}</kbd></button><span className="top-divider"/><IconButton label="设置" onClick={() => setModal('settings')}><SlidersHorizontal size={18}/></IconButton></div></header>
      {banner && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{banner}</span><button onClick={() => void refresh()}>重新加载</button><IconButton label="关闭错误提示" onClick={dismissError}><X size={14}/></IconButton></div>}
      <div className="content-shell"><section className="list-pane" aria-label="剪贴记录">
        <div className="list-heading"><div><h1>{heading}</h1><span>{visible.length} 条记录<span className="heading-dot">·</span>{nav === '最近删除' ? '7 天后自动清理' : '留住每一次灵感'}</span></div><IconButton label="查看快捷窗口" onClick={openQuick}><MoreHorizontal size={21}/></IconButton></div>
        <div className="search-box"><Search size={17}/><input ref={searchRef} aria-label="搜索记录" maxLength={1000} placeholder="搜索你的剪贴记录…" value={query} onChange={e => setQuery(e.target.value)}/>{query ? <button aria-label="清空搜索" onClick={() => setQuery('')}><X size={14}/></button> : <kbd>Ctrl K</kbd>}</div>
        <div className="list-toolbar"><div className="toolbar-filters"><label><select aria-label="内容类型筛选" value={kind} onChange={e => setKind(e.target.value)}><option value="all">所有类型</option><option value="text">文本</option><option value="link">链接</option><option value="image">图片</option><option value="file">文件</option></select><ChevronDown size={13}/></label><label><select aria-label="来源应用筛选" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">所有来源</option>{sources.map(source => <option key={source} value={source}>{source}</option>)}</select><ChevronDown size={13}/></label></div><span>{busy ? '正在保存…' : '最近复制'}<ArrowDown size={13}/></span></div>
        <div className="clip-list" onKeyDown={e => { if(e.key === 'Enter') { e.preventDefault(); document.querySelector<HTMLElement>('.detail-pane')?.focus() } if(e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = visible.findIndex(c => c.id === summary?.id), next = Math.max(0, Math.min(visible.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))); if(visible[next]) { setSelectedId(visible[next].id); e.currentTarget.querySelectorAll<HTMLButtonElement>('.clip-row')[next]?.focus() } } }}>
          {(loading || mainSearch.loading) && <div className="list-empty" role="status">{loading ? '正在读取记录…' : '正在搜索…'}</div>}
          {!loading && !mainSearch.loading && visible.length === 0 && <div className="list-empty"><Search size={27}/><strong>{clips.length === 0 && !query ? '复制一段内容，从这里开始' : '没有找到相关记录'}</strong><span>{native && clips.length === 0 ? '文本、链接、图片与文件会自动出现在这里' : '试试其他关键词或内容类型'}</span>{(query || kind !== 'all' || sourceFilter !== 'all') && <button className="text-button" onClick={() => { setQuery(''); setKind('all'); setSourceFilter('all') }}>清除筛选</button>}</div>}
          {visible.map((c, i) => <div key={c.id}>{(i === 0 || dayOf(visible[i - 1]) !== dayOf(c)) && <div className="date-group">{dayOf(c)}<span>{new Date(c.capturedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span></div>}<button className={`clip-row ${summary?.id === c.id ? 'row-selected' : ''}`} onClick={() => setSelectedId(c.id)} aria-pressed={summary?.id === c.id}>{c.type === 'image' || imageFile(c) ? <Thumb clip={c}/> : <div className={`type-tile type-${c.type}`}><TypeIcon type={c.type}/></div>}<div className="clip-row-text"><div className="clip-row-title">{c.title || '未命名记录'}</div><p>{c.type === 'image' ? native ? '图片' : '图片 · 设计示例' : c.type === 'file' ? fileSummary(c.content, c.fileSize) : c.content.replace(/\n/g, ' ')}</p><div className="row-meta"><span className="source-dot source-other"/>{c.source}<span className="row-time">{c.time}</span></div></div>{c.favorite && <Star className="row-star" size={12} fill="currentColor"/>}</button></div>)}
        </div><div className="list-footer"><span>{paused ? '已暂停采集' : native ? '所有内容仅保存在本地' : '虚构数据 · 刷新重置'}</span><Monitor size={14}/></div>
      </section>
      <section className="detail-pane" aria-label="记录详情" tabIndex={-1}>
        {selected ? <><div className="detail-toolbar"><span><TypeIcon type={selected.type} size={15}/>{typeNames[selected.type]}预览</span><div>{!selected.deleted && <IconButton label={selected.favorite ? '取消收藏' : '收藏记录'} active={selected.favorite} disabled={busy} onClick={() => void update(selected.id, { favorite: !selected.favorite })}><Star size={18} fill={selected.favorite ? 'currentColor' : 'none'}/></IconButton>}{selected.deleted ? <IconButton label="恢复记录" disabled={busy} onClick={() => void restore(selected.id)}><RotateCcw size={18}/></IconButton> : <IconButton label="删除记录" disabled={busy} onClick={() => { void update(selected.id, { deleted: true }).then(ok => { if(ok) notice('已移到最近删除') }) }}><Trash2 size={18}/></IconButton>}</div></div>
        <div className="detail-scroll"><div className="detail-content"><div className={`type-tile detail-type type-${selected.type}`}><TypeIcon type={selected.type} size={26}/></div><div className="detail-title-row"><h2>{selected.title || '未命名记录'}</h2>{selected.favorite && <span className="favorite-badge"><Star size={12} fill="currentColor"/>已收藏</span>}</div><div className="detail-subtitle">来自 {selected.source}<span>·</span>{dayOf(selected)} {selected.time}</div>
        {selected.type === 'image' ? <Picture key={selected.id} clip={selected}/> : !detail ? <div className="text-preview"><pre>{detailError ? '内容读取失败，请重新加载。' : '正在读取完整内容…'}</pre></div> : selected.type === 'link' ? <div className="link-preview"><div className="link-site-icon"><Link2 size={25}/></div><div><strong>{selected.title}</strong><span>{hostname(selected.content)}</span></div><IconButton label="在浏览器打开链接" onClick={() => void openLink(selected)}><ArrowUpRight size={20}/></IconButton></div> : selected.type === 'file' ? <div className="file-preview"><div className="preview-label">文件与文件夹<span>{fileEntries(selected).length} 项{selected.fileSize > 0 ? ` · ${formatBytes(selected.fileSize)}` : ''}</span></div>{imageFile(selected) && <Picture key={`${selected.id}-file`} clip={selected}/>}{selected.fileSize >= FILE_WARN && <div className="file-warning" role="status"><AlertCircle size={15}/><span>总大小达到 1 GB。复制记录只写入路径；粘贴时由目标应用实际复制，可能耗时并占用磁盘。</span></div>}<div className="file-rows">{fileEntries(selected).map((entry, i) => <div className="file-row" key={`${i}-${entry.path}`}><FolderOpen size={17}/><div><strong>{baseName(entry.path)}</strong><span>{entry.path}</span><em>{entry.isDir ? '文件夹' : entry.size === null ? '大小未知' : formatBytes(entry.size)}{entry.modifiedAt !== null ? ` · ${formatModified(entry.modifiedAt)}` : ''}</em></div></div>)}</div></div> : <div className={`text-preview ${selected.content.startsWith('import ') ? 'code-preview' : ''}`}><div className="preview-label">{selected.content.startsWith('import ') ? '代码 / 纯文本' : '纯文本'}<span>{[...selected.content].length} 字符</span></div><pre>{selected.content}</pre></div>}
        <div className="primary-actions">{selected.deleted ? <><button disabled={busy} className="primary-button" onClick={() => void restore(selected.id)}><RotateCcw size={16}/>恢复记录</button><button disabled={busy} className="danger-button" onClick={() => setConfirmDelete(selected.id)}>彻底删除</button></> : <><button disabled={copying} className="primary-button" onClick={() => void copy(selected)}><Copy size={16}/>{copying ? '正在复制…' : selected.type === 'file' ? '复制文件' : '复制内容'}</button>{selected.type === 'link' && <button className="secondary-button" onClick={() => void openLink(selected)}>打开链接<ArrowUpRight size={15}/></button>}<span className="action-hint">{selected.type === 'file' ? '粘贴到资源管理器或其他应用' : '随时找回，再次使用'}</span></>}</div>
        <div className="info-section"><h3>记录信息</h3><div className="info-row"><span>名称</span><Editable key={`title-${selected.id}`} cache={drafts.current} cacheKey={`title-${selected.id}`} label="记录名称" value={selected.title} maxLength={200} disabled={selected.deleted} save={value => update(selected.id, { title: value })}/></div><div className="info-row"><span>来源应用</span><div><span className="source-dot source-other"/>{selected.source}{selected.source !== '未知来源' && <button className="text-button exclude-link" disabled={busy || selected.deleted} title={`不再记录来自 ${selected.source} 的内容`} onClick={() => void excludeApp(selected.source)}><ShieldOff size={12}/>排除此应用</button>}</div></div><div className="info-row"><span>复制时间</span><div>{new Date(selected.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div></div>{selected.type === 'file' && <><div className="info-row"><span>总大小</span><div>{selected.fileSize > 0 ? formatBytes(selected.fileSize) : '未知或空文件夹'}</div></div><div className="info-row"><span>最近修改</span><div>{formatModified(selected.fileModifiedAt)}</div></div></>}<div className="info-row collections-row"><span>所属集合</span><div>{selected.collections.map(name => <button disabled={selected.deleted || busy} className="collection-chip" key={name} title={`从${name}移除`} onClick={() => void update(selected.id, { collections: selected.collections.filter(n => n !== name) })}><Folder size={12}/>{name}<X size={11}/></button>)}{!selected.deleted && <select disabled={busy} aria-label="加入集合" value="" onChange={e => { if(e.target.value) void update(selected.id, { collections: [...selected.collections, e.target.value] }) }}><option value="">＋ 加入集合</option>{collections.filter(name => !selected.collections.includes(name)).map(name => <option key={name}>{name}</option>)}</select>}</div></div></div>
        <div className="note-section"><h3>备注<span>{busy ? '正在保存…' : '失焦后自动保存'}</span></h3><Editable key={`note-${selected.id}`} cache={drafts.current} cacheKey={`note-${selected.id}`} label="备注" value={selected.note} multiline maxLength={10000} disabled={selected.deleted} save={value => update(selected.id, { note: value })}/></div></div></div>
        <div className="detail-footer"><ShieldCheck size={14}/><span>{native ? '这条记录只属于你，保存在你的设备上。' : '浏览器演示使用虚构内容。'}</span><kbd>MyPaste</kbd></div></> : <div className="detail-empty"><div className="empty-illustration"><Clipboard size={44}/></div><h2>留一点空间，给下一次灵感</h2><p>{loading ? '正在连接本地数据…' : '选择一条记录，在这里查看完整内容。'}</p></div>}
      </section></div>
    </main>
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
    {modal === 'collection' && <Modal title="新建集合" onClose={() => void closeModal()}><form onSubmit={e => { e.preventDefault(); const name = collectionName.trim(); if(!name) return; void run(() => service.createCollection(name)).then(ok => { if(ok) { setCollectionName(''); setModal(null); go(name) } }) }}><label className="field-label">集合名称<input maxLength={80} placeholder="例如：写作素材" value={collectionName} onChange={e => setCollectionName(e.target.value)}/></label><p className="form-help">把经常一起使用的内容放在一起。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => void closeModal()}>取消</button><button className="primary-button" disabled={busy || !collectionName.trim()}>创建集合</button></div></form></Modal>}
    {modal === 'settings' && <Modal title="设置" onClose={() => void closeModal()} className="settings-modal"><div className="settings-tabs">{['通用','历史保留','隐私'].map(t => <button key={t} className={settingsTab === t ? 'active' : ''} onClick={() => setSettingsTab(t)}>{t}</button>)}</div><div className="settings-body">
      {settingsTab === '通用' ? <><div className="settings-intro"><Keyboard size={23}/><h3>让工作少一点打断</h3><p>随时呼出，快速找回复制过的内容。</p></div><div className="setting-row"><div>快捷呼出<small>{native ? status?.shortcutRegistered ? '全局快捷键已注册' : status?.shortcutError ?? '尚未注册' : '浏览器仅在当前页面使用'}</small></div><div className="shortcut-editor"><input aria-label="全局快捷键" value={shortcutDraft} maxLength={80} onChange={e => setShortcutDraft(e.target.value)}/><button disabled={!native || busy || !shortcutDraft.trim()} className="secondary-button" onClick={() => void run(() => service.settings({ shortcut: shortcutDraft.trim() })).then(ok => { if(ok) notice('快捷键已更新') })}>保存</button></div></div><div className="setting-row"><div>暂停记录<small>{native ? '重启后保持暂停状态' : '此处仅演示状态切换'}</small></div><button disabled={busy || !snapshot} role="switch" aria-checked={paused} aria-label="暂停记录" className={`switch ${paused ? 'on' : ''}`} onClick={() => void togglePaused()}><span/></button></div><div className="setting-row"><div>软件更新<small>当前版本 {appVersion || '读取中…'}{!native ? ' · 浏览器演示不检查更新' : ''}</small>{updateState === 'latest' && <small role="status">已是最新版本</small>}{updateInfo && <small role="status">发现新版本 {updateInfo.version}{updateInfo.notes ? `：${updateInfo.notes}` : '，包含修复与改进'}</small>}{updateState === 'downloading' && <small role="status">正在下载{updateProgress?.total ? ` ${Math.min(100, Math.round(updateProgress.downloaded / updateProgress.total * 100))}%` : updateProgress ? ` ${formatBytes(updateProgress.downloaded)}` : '…'}</small>}{updateError && <small className="setting-error" role="alert">{updateError}</small>}</div>{updateInfo ? <button className="secondary-button" disabled={updateState === 'downloading'} onClick={() => void installUpdate()}>{updateState === 'downloading' ? '正在安装…' : '下载并安装'}</button> : <button className="secondary-button" disabled={!native || updateState === 'checking'} onClick={() => void checkUpdates()}>{updateState === 'checking' ? '正在检查…' : '检查更新'}</button>}</div><div className="settings-notice">{native ? '关闭主窗口后仍在托盘运行。请从托盘菜单退出。快捷键被占用时，可以更换组合。' : '这是浏览器演示。使用桌面版体验真实监听、托盘和全局快捷键。'}</div></> : settingsTab === '历史保留' ? <><h3>给常用内容多留一点时间</h3><p className="form-help">收藏不参与时间和条数清理。删除内容在回收站保留 7 天。</p><div className="setting-row"><div>普通记录保留时间</div><select disabled={busy || !settings} aria-label="保留天数" value={settings?.retentionDays ?? 30} onChange={e => void run(() => service.settings({ retentionDays: Number(e.target.value) }))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></div><div className="setting-row"><div>最大普通历史条数</div><select disabled={busy || !settings} aria-label="历史条数" value={settings?.maxItems ?? 500} onChange={e => void run(() => service.settings({ maxItems: Number(e.target.value) }))}><option value={500}>500 条</option><option value={1000}>1,000 条</option><option value={5000}>5,000 条</option></select></div><div className="settings-notice">{native ? '设置保存在本机，到期和超量记录进入回收站。' : '演示选择仅保留在当前页面，不执行清理。'}图片单张最多 10 MiB，总计 500 MiB。</div></> : <><div className="settings-intro"><ShieldCheck size={25}/><h3>你的剪贴板，留在你的设备</h3><p>无需账号，默认不上传剪贴内容。</p></div><div className="setting-row"><div>本地保存<small>{native ? snapshot?.dataDir || '正在读取目录…' : '演示使用虚构内容，刷新后重置'}</small></div><ShieldCheck size={19}/></div><div className="exclude-block"><h4>不记录这些应用的内容</h4><p className="form-help">切换窗口时，来自这些应用的复制内容会在读取前被跳过，不会写入历史。</p><form className="exclude-add" onSubmit={e => { e.preventDefault(); const name = appDraft; void excludeApp(name).then(() => setAppDraft('')) }}><input aria-label="排除的应用名称" maxLength={120} placeholder="应用名，例如 KeePassXC" value={appDraft} onChange={e => setAppDraft(e.target.value)}/><button className="secondary-button" disabled={busy || !appDraft.trim()}>添加</button></form>{(settings?.excludedApps.length ?? 0) > 0 ? <div className="exclude-list">{settings!.excludedApps.map(name => <span className="exclude-chip" key={name}><ShieldOff size={12}/>{name}<button aria-label={`恢复记录来自 ${name} 的内容`} disabled={busy} onClick={() => void removeExcluded(name)}><X size={11}/></button></span>)}</div> : <p className="empty-inline">尚未排除任何应用。</p>}</div><div className="settings-notice">本地存储不等同于加密保险箱。排除规则在读取剪贴板前生效；来源识别失败时无法匹配，因此不能承诺拦截所有敏感内容。处理密码或密钥前，仍建议暂停记录。</div></>}
    </div><div className="modal-actions"><button className="primary-button" onClick={() => void closeModal()}>完成</button></div></Modal>}
    {modal === 'quick' && <Modal title="快捷窗口" onClose={() => void closeModal()} className="quick-modal"><div className="quick-brand"><div className="brand-icon"><Clipboard size={18}/></div><strong>找回刚才的内容</strong><span>个人空间</span></div><div className="quick-search"><Search size={21}/><input role="combobox" aria-expanded="true" aria-controls="quick-results" aria-activedescendant={quickSelected ? `quick-${quickSelected.id}` : undefined} aria-label="快捷搜索" maxLength={1000} placeholder="搜索文字、链接、灵感…" value={quickQuery} onChange={e => { setQuickQuery(e.target.value); setQuickIndex(0) }} onKeyDown={e => { if(e.key === 'ArrowDown') { e.preventDefault(); setQuickIndex(i => Math.min(i + 1, Math.max(0, quickItems.length - 1))) } if(e.key === 'ArrowUp') { e.preventDefault(); setQuickIndex(i => Math.max(0, i - 1)) } if(e.key === 'Enter' && quickSelected) { e.preventDefault(); void copy(quickSelected, true, e.ctrlKey) } }}/><kbd>Esc</kbd></div><div className="quick-filters" role="group" aria-label="快捷筛选"><div className="quick-chips">{(['all','text','link','image','file'] as const).map(t => <button key={t} className={`quick-chip ${quickKind === t ? 'active' : ''}`} aria-pressed={quickKind === t} onClick={() => { setQuickKind(t); setQuickIndex(0) }}>{t === 'all' ? '全部' : typeNames[t]}</button>)}</div><button className="quick-sort" title="切换排序方式" onClick={() => { setQuickSort(s => s === 'recent' ? 'used' : 'recent'); setQuickIndex(0) }}>{quickSort === 'recent' ? '最近复制' : '最常使用'}{quickSort === 'recent' ? <ArrowDown size={12}/> : <Zap size={12}/>}</button><label className="quick-select"><Folder size={13}/><select aria-label="集合筛选" value={quickCollection} onChange={e => { setQuickCollection(e.target.value); setQuickIndex(0) }}><option value="all">所有集合</option>{collections.map(name => <option key={name} value={name}>{name}</option>)}</select><ChevronDown size={12}/></label></div>{quickNotice && <div className="quick-notice" role="status"><AlertCircle size={14}/><span>{quickNotice}</span></div>}<div className="quick-results" id="quick-results" role="listbox" aria-label="快捷搜索结果"><div className="date-group">{quickQuery ? '搜索结果' : quickSort === 'used' ? '最常使用' : '最近复制'}<span>{quickItems.length} 条</span></div>{quickItems.length === 0 && <div className="list-empty">{quickSearch.loading ? '正在搜索…' : '没有找到相关记录'}{!quickSearch.loading && (quickKind !== 'all' || quickCollection !== 'all') && <button className="text-button" onClick={() => { setQuickKind('all'); setQuickCollection('all') }}>清除筛选</button>}</div>}{quickItems.map((c, i) => <button disabled={copying} id={`quick-${c.id}`} role="option" aria-selected={quickSelected?.id === c.id} key={c.id} className={`quick-row ${quickSelected?.id === c.id ? 'active' : ''}`} onFocus={() => setQuickIndex(i)} onClick={() => { setQuickIndex(i); void copy(c, true) }}>{c.type === 'image' || imageFile(c) ? <Thumb clip={c}/> : <div className={`type-tile type-${c.type}`}><TypeIcon type={c.type}/></div>}<div><strong>{c.title || '未命名记录'}</strong><span>{c.type === 'image' ? '图片' : c.type === 'file' ? fileSummary(c.content, c.fileSize) : c.content.replace(/\n/g,' ')}</span></div>{quickSelected?.id === c.id && <kbd>↵ 复制</kbd>}</button>)}</div><div className="quick-footer"><span><ArrowUp size={12}/><ArrowDown size={12}/>选择<kbd>↵</kbd>复制<kbd>Ctrl ↵</kbd>粘贴</span><span><Zap size={13}/>{native ? '本地剪贴板' : '浏览器演示'}</span></div></Modal>}
    {deletionTarget && <Modal title="彻底删除这条记录？" onClose={() => setConfirmDelete(null)}><p className="form-help">“{deletionTarget.title}”将从{native ? '本机数据库' : '当前演示'}移除，无法恢复。</p><div className="modal-actions"><button className="secondary-button" onClick={() => setConfirmDelete(null)}>取消</button><button disabled={busy} className="danger-button" onClick={() => void run(() => service.purge(deletionTarget.id)).then(ok => { if(ok) { setConfirmDelete(null); notice('记录已彻底删除') } })}>彻底删除</button></div></Modal>}
  </div>
}
