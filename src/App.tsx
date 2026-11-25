import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react'
import { AlertCircle, Check, X } from 'lucide-react'
import { clipboardService as service, errorMessage, native, type Clip, type ClipPatch, type CopyMode, type DbUsage, type LogInfo, type RichFormat, type Settings, type UpdateCheck, type UpdateProgress } from '@/clipboard-service'
import { useClipboard, useClipDetail, useSearchIds } from '@/use-clipboard'
import { appKey, typeNames } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Sidebar, type SidebarCounts } from '@/components/app/sidebar'
import { Topbar } from '@/components/app/topbar'
import { ClipList } from '@/components/app/clip-list'
import { ClipDetail } from '@/components/app/clip-detail'
import { QuickSwitcher } from '@/components/app/quick-switcher'
import { SettingsDialog } from '@/components/app/settings-dialog'
import { CollectionsDialog } from '@/components/app/collections-dialog'
import { ConfirmDialog, NewCollectionDialog } from '@/components/app/dialogs'
import { Editable, type DraftStore } from '@/components/app/shared'

export { Editable }

export default function App() {
  const quickOnly = window.location.hash === '#quick'
  const [nav, setNav] = useState('全部记录'), [query, setQuery] = useState(''), [sourceFilter, setSourceFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<number>(), [modal, setModal] = useState<'settings' | 'quick' | 'collection' | null>(quickOnly ? 'quick' : null)
  const [collectionName, setCollectionName] = useState(''), [toast, setToast] = useState(''), [toastTone, setToastTone] = useState<'ok' | 'error'>('ok'), [quickNotice, setQuickNotice] = useState('')
  const [settingsTab, setSettingsTab] = useState('通用'), [shortcutDraft, setShortcutDraft] = useState('Ctrl+Shift+V'), [appDraft, setAppDraft] = useState('')
  const [appVersion, setAppVersion] = useState(''), [updateState, setUpdateState] = useState<'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'error'>('idle')
  const [updateInfo, setUpdateInfo] = useState<UpdateCheck | null>(null), [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null), [updateError, setUpdateError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null), [sidebarOpen, setSidebarOpen] = useState(false), [copying, setCopying] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<string | null>(null), [pendingDataDir, setPendingDataDir] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [bulkDelete, setBulkDelete] = useState(false), [manageCollections, setManageCollections] = useState(false)
  const [usage, setUsage] = useState<DbUsage | null>(null), [compacting, setCompacting] = useState(false)
  const [logInfo, setLogInfo] = useState<LogInfo | null>(null), [pendingElevated, setPendingElevated] = useState(false)
  const drafts = useRef<DraftStore>(new Map()), portalRef = useRef<HTMLDivElement>(null)
  const desktopQuick = useRef(quickOnly), quickSession = useRef(0), searchRef = useRef<HTMLInputElement>(null)
  const { snapshot, loading, busy, error, revision, run, refresh, dismissError } = useClipboard(() => { quickSession.current++; desktopQuick.current = true; setConfirmDelete(null); setQuickNotice(''); setModal('quick') })
  const clips = snapshot?.items ?? [], collections = snapshot?.collections ?? [], settings = snapshot?.settings, status = snapshot?.status, paused = settings?.paused ?? false
  const sequence = snapshot?.sequence, collectionPolicies = snapshot?.collectionPolicies ?? []
  const mainSearch = useSearchIds(query, revision)
  const active = clips.filter(c => !c.deleted)
  const sources = [...new Set(clips.filter(c => c.deleted === (nav === '最近删除')).map(c => c.source).filter(Boolean))]
  const navScope = clips.filter(c => c.deleted === (nav === '最近删除') && (nav !== '收藏' || c.favorite) && (!['text','link','image','file'].includes(nav) || c.type === nav) && (!collections.includes(nav) || c.collections.includes(nav)))
  const filtered = query !== '' || sourceFilter !== 'all'
  const visible = navScope.filter(c => (sourceFilter === 'all' || c.source === sourceFilter) && (!mainSearch.ids || mainSearch.ids.has(c.id))).sort((a, b) => Number(b.pinned) - Number(a.pinned))
  const summary = visible.find(c => c.id === selectedId) ?? visible[0]
  const { detail, error: detailError } = useClipDetail(summary?.id, revision)
  const selected = detail ?? summary, heading = Object.hasOwn(typeNames, nav) ? typeNames[nav as keyof typeof typeNames] : nav
  const counts: SidebarCounts = {
    all: active.length,
    favorites: active.filter(c => c.favorite).length,
    text: active.filter(c => c.type === 'text').length,
    link: active.filter(c => c.type === 'link').length,
    image: active.filter(c => c.type === 'image').length,
    file: active.filter(c => c.type === 'file').length,
  }
  const deletionTarget = clips.find(c => c.id === confirmDelete)
  const notice = (text: string, tone: 'ok' | 'error' = 'ok') => { setToastTone(tone); setToast(text) }
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
  useEffect(() => { if(!checked.size) setBulkDelete(false) }, [checked])
  useEffect(() => { void service.version().then(setAppVersion).catch(() => setAppVersion('')) }, [])
  useEffect(() => { if(!quickOnly) return; const onFocus = () => void refresh(); window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus) }, [quickOnly, refresh])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !modal) { e.preventDefault(); searchRef.current?.focus() } if(!native && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v' && confirmDelete === null) { e.preventDefault(); quickSession.current++; desktopQuick.current = false; setModal('quick') } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [modal, confirmDelete])
  const update = (id: number, patch: ClipPatch) => run(() => service.update(id, patch))
  async function closeModal(session = quickSession.current) {
    if(session !== quickSession.current) return
    if(desktopQuick.current) {
      try { await service.hideQuick() } catch(cause) { notice(errorMessage(cause), 'error'); return }
      if(session !== quickSession.current) return
    }
    desktopQuick.current = false; quickSession.current++; setModal(null); setQuickNotice('')
  }
  function openQuick() { quickSession.current++; desktopQuick.current = false; setQuickNotice(''); setModal('quick') }
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
    } catch(cause) { const message = errorMessage(cause); if(close) setQuickNotice(message); notice(message, 'error') } finally { setCopying(false) }
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
  async function openLink(c: Clip) { try { await service.openLink(c.id) } catch(cause) { notice(errorMessage(cause), 'error') } }
  async function exportBackup() {
    try { const path = await service.exportBackup(); if(path) notice(`备份已导出到 ${path}`) } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function pickRestore() {
    try { const path = await service.pickBackup(); if(path) setPendingRestore(path) } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function restoreBackup() {
    if(!pendingRestore) return
    try { await service.importBackup(pendingRestore); setPendingRestore(null); await refresh(); notice('已从备份恢复') } catch(cause) { setPendingRestore(null); notice(errorMessage(cause), 'error') }
  }
  async function chooseDataDir() {
    try { const path = await service.chooseDataDir(); if(path && path !== snapshot?.dataDir) setPendingDataDir(path) } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function moveDataDir() {
    if(!pendingDataDir) return
    try { await service.setDataDir(pendingDataDir); notice('正在迁移数据并重启…') } catch(cause) { setPendingDataDir(null); notice(errorMessage(cause), 'error') }
  }
  async function openDataDir() { try { await service.openDataDir() } catch(cause) { notice(errorMessage(cause), 'error') } }
  function go(value: string) { setNav(value); setQuery(''); setSourceFilter('all'); setSelectedId(undefined); setSidebarOpen(false) }
  async function restore(id: number) { if(await update(id, { deleted: false })) notice('记录已恢复') }
  const selectAnchor = useRef<number | null>(null)
  function selectRow(c: Clip, e: MouseEvent) {
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
  function listKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if((event.target as HTMLElement).tagName === 'SELECT') return
    if((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setChecked(new Set(visible.map(c => c.id))); return }
    if(event.key === 'Escape' && checked.size) { event.preventDefault(); setChecked(new Set()); return }
    if(event.key === 'Enter') { event.preventDefault(); document.querySelector<HTMLElement>('.detail-pane')?.focus() }
    if(event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const index = visible.findIndex(c => c.id === summary?.id), next = Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
      if(visible[next]) { setSelectedId(visible[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('.clip-row')[next]?.focus() }
    }
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
    try {
      await service.copyVariant(c.id, mode)
      notice(mode === 'trim' ? '已复制，首尾空白已去除' : mode === 'one_line' ? '已复制为单行' : '已复制为纯文本')
      await refresh()
    } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function copyFormat(c: Clip, format: RichFormat) {
    try {
      await service.copyFormat(c.id, format)
      notice(format === 'rtf' ? '已复制为 RTF 格式' : '已复制为 HTML 格式')
      await refresh()
    } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function renameCollection(from: string, to: string) {
    if(!to || to === from) return false
    if(!await run(() => service.renameCollection(from, to))) return false
    if(nav === from) setNav(to)
    notice('集合已重命名')
    return true
  }
  async function removeCollection(name: string) {
    if(!await run(() => service.deleteCollection(name))) return false
    if(nav === name) go('全部记录')
    notice(`已删除集合「${name}」，记录仍保留`)
    return true
  }
  async function moveCollection(name: string, direction: 'up' | 'down') { await run(() => service.moveCollection(name, direction)) }
  async function toggleAutostart() {
    try {
      const enabled = await service.setAutostart(!(status?.autostart ?? false))
      await refresh(); notice(enabled ? '已开启开机启动' : '已关闭开机启动')
    } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function compact() {
    setCompacting(true)
    try { setUsage(await service.compactDatabase()); notice('数据库已整理') } catch(cause) { notice(errorMessage(cause), 'error') } finally { setCompacting(false) }
  }
  async function startSequence() {
    if(!checked.size) return
    try {
      const status = await service.startSequence([...checked])
      setChecked(new Set())
      notice(status.active ? `序列粘贴已开始（共 ${status.total} 条），按 ${settings?.shortcut ?? 'Ctrl+Shift+V'} 粘贴下一项` : '已复制所选记录')
    } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function nextSequence() {
    try {
      const status = await service.sequenceNext()
      notice(status.active ? `已复制第 ${status.position}/${status.total} 项` : '序列粘贴已完成')
    } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function stopSequence() {
    try { await service.stopSequence(); notice('序列粘贴已结束') } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function savePolicy(name: string, retentionDays: number | null, maxItems: number | null) {
    if(await run(() => service.setCollectionPolicy(name, retentionDays, maxItems))) notice(retentionDays === null && maxItems === null ? `「${name}」已跟随全局保留策略` : `已更新「${name}」的保留策略`)
  }
  async function restartElevated() {
    setPendingElevated(false)
    try { await service.restartElevated(); notice('正在以管理员身份重启…') } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function openLogDir() { try { await service.openLogDir() } catch(cause) { notice(errorMessage(cause), 'error') } }
  async function exportDiagnostics() {
    try { const path = await service.exportDiagnostics(); if(path) notice(`诊断信息已导出到 ${path}`) } catch(cause) { notice(errorMessage(cause), 'error') }
  }
  async function saveShortcut() { if(await run(() => service.settings({ shortcut: shortcutDraft.trim() }))) notice('快捷键已更新') }
  async function createCollection() {
    const name = collectionName.trim()
    if(!name) return
    if(await run(() => service.createCollection(name))) { setCollectionName(''); setModal(null); go(name) }
  }
  function applySettings(patch: Partial<Settings>) { void run(() => service.settings(patch)) }
  const banner = error || mainSearch.error || detailError
  return <div className={cn('app-shell flex h-dvh min-h-0 overflow-hidden bg-background', quickOnly && 'quick-only')}>
    {!quickOnly && <Sidebar
      collections={collections}
      counts={counts}
      captureState={status?.captureState}
      busy={busy}
      nav={nav}
      nativeMode={native}
      onCloseSidebar={() => setSidebarOpen(false)}
      onManageCollections={() => setManageCollections(true)}
      onNavigate={go}
      onNewCollection={() => setModal('collection')}
      onSettings={() => setModal('settings')}
      onTogglePaused={() => void togglePaused()}
      paused={paused}
      ready={!!snapshot}
      sidebarOpen={sidebarOpen}
    />}
    {!quickOnly && <main className="main-shell flex min-w-0 flex-1 flex-col">
      <Topbar
        heading={heading}
        nativeMode={native}
        onOpenQuick={openQuick}
        onOpenSettings={() => setModal('settings')}
        onOpenSidebar={() => setSidebarOpen(true)}
        shortcut={settings?.shortcut ?? 'Ctrl+Shift+V'}
      />
      {banner && <div className="error-banner mx-3 mt-2 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12px] text-[var(--destructive-foreground)]" role="alert">
        <AlertCircle size={15} />
        <span className="min-w-0 flex-1 break-words">{banner}</span>
        <button className="shrink-0 text-[11px] underline" onClick={() => void refresh()} type="button">重新加载</button>
        <button aria-label="关闭错误提示" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={dismissError} type="button"><X size={13} /></button>
      </div>}
      <div className="content-shell flex min-h-0 flex-1 max-[680px]:flex-col">
        <ClipList
          busy={busy}
          checked={checked}
          collections={collections}
          filtered={filtered}
          heading={heading}
          loading={loading}
          nativeMode={native}
          nav={nav}
          navScopeCount={navScope.length}
          onBatchAdd={name => void batchAdd(name)}
          onBatchPatch={(patch, message) => void batchPatch(patch, message)}
          onClearChecked={() => setChecked(new Set())}
          onClearFilters={() => { setQuery(''); setSourceFilter('all') }}
          onListKeyDown={listKeyDown}
          onNextSequence={() => void nextSequence()}
          onOpenQuick={openQuick}
          onQuery={setQuery}
          onRequestBulkDelete={() => setBulkDelete(true)}
          onSelectRow={selectRow}
          onSourceFilter={setSourceFilter}
          onStartSequence={() => void startSequence()}
          onStopSequence={() => void stopSequence()}
          paused={paused}
          query={query}
          searchRef={searchRef}
          searching={mainSearch.loading}
          sequence={sequence}
          shortcut={settings?.shortcut ?? 'Ctrl+Shift+V'}
          sourceFilter={sourceFilter}
          sources={sources}
          summaryId={summary?.id}
          visible={visible}
        />
        <ClipDetail
          busy={busy}
          collections={collections}
          copying={copying}
          detail={detail}
          detailError={detailError}
          drafts={drafts.current}
          loading={loading}
          nativeMode={native}
          onCopy={clip => void copy(clip)}
          onCopyFormat={(clip, format) => void copyFormat(clip, format)}
          onCopyVariant={(clip, mode) => void copyVariant(clip, mode)}
          onDelete={id => { void update(id, { deleted: true }).then(ok => { if(ok) notice('已移到最近删除') }) }}
          onExcludeApp={name => void excludeApp(name)}
          onOpenLink={clip => void openLink(clip)}
          onRequestPurge={id => setConfirmDelete(id)}
          onRestore={id => void restore(id)}
          onUpdate={update}
          portalContainer={portalRef.current}
          selected={selected}
        />
      </div>
    </main>}

    <QuickSwitcher
      active={active}
      collections={collections}
      copying={copying}
      dragging={quickOnly}
      nativeMode={native}
      notice={quickNotice}
      onClose={() => void closeModal()}
      onCopy={copy}
      open={modal === 'quick'}
      portalContainer={portalRef.current}
      quickOnly={quickOnly}
      revision={revision}
      shortcut={settings?.shortcut ?? 'Ctrl+Shift+V'}
    />

    <SettingsDialog
      appDraft={appDraft}
      appVersion={appVersion}
      busy={busy}
      compacting={compacting}
      logInfo={logInfo}
      nativeMode={native}
      onAppDraft={setAppDraft}
      onCheckUpdates={() => void checkUpdates()}
      onChooseDataDir={() => void chooseDataDir()}
      onClose={() => void closeModal()}
      onCompact={() => void compact()}
      onExcludeApp={name => void excludeApp(name)}
      onExportBackup={() => void exportBackup()}
      onExportDiagnostics={() => void exportDiagnostics()}
      onInstallUpdate={() => void installUpdate()}
      onOpenDataDir={() => void openDataDir()}
      onOpenLogDir={() => void openLogDir()}
      onPickRestore={() => void pickRestore()}
      onRemoveExcluded={name => void removeExcluded(name)}
      onRequestElevated={() => setPendingElevated(true)}
      onSaveShortcut={() => void saveShortcut()}
      onSettings={applySettings}
      onShortcutDraft={setShortcutDraft}
      onTab={setSettingsTab}
      onToggleAutostart={() => void toggleAutostart()}
      onTogglePaused={() => void togglePaused()}
      open={modal === 'settings'}
      portalContainer={portalRef.current}
      settings={settings}
      shortcutDraft={shortcutDraft}
      snapshot={snapshot ?? undefined}
      status={status}
      tab={settingsTab}
      updateError={updateError}
      updateInfo={updateInfo}
      updateProgress={updateProgress}
      updateState={updateState}
      usage={usage}
    />

    <CollectionsDialog
      active={active}
      busy={busy}
      collections={collections}
      onClose={() => setManageCollections(false)}
      onDelete={removeCollection}
      onMove={(name, direction) => void moveCollection(name, direction)}
      onPolicy={(name, retentionDays, maxItems) => void savePolicy(name, retentionDays, maxItems)}
      onRename={renameCollection}
      open={manageCollections}
      policies={collectionPolicies}
      portalContainer={portalRef.current}
    />

    <NewCollectionDialog
      busy={busy}
      name={collectionName}
      onClose={() => setModal(null)}
      onCreate={() => void createCollection()}
      onName={setCollectionName}
      open={modal === 'collection'}
      portalContainer={portalRef.current}
    />

    <ConfirmDialog
      busy={busy}
      confirmLabel="彻底删除"
      description={deletionTarget ? <>“{deletionTarget.title}”将从{native ? '本机数据库' : '当前演示'}移除，无法恢复。</> : null}
      onClose={() => setConfirmDelete(null)}
      onConfirm={() => { if(deletionTarget) void run(() => service.purge(deletionTarget.id)).then(ok => { if(ok) { setConfirmDelete(null); notice('记录已彻底删除') } }) }}
      open={confirmDelete !== null && !!deletionTarget}
      portalContainer={portalRef.current}
      title="彻底删除这条记录？"
      tone="danger"
    />
    <ConfirmDialog
      busy={busy}
      confirmLabel="恢复"
      description="当前全部记录会被备份中的内容替换，应用设置保持不变。此操作无法撤销。"
      detail={pendingRestore}
      onClose={() => setPendingRestore(null)}
      onConfirm={() => void restoreBackup()}
      open={!!pendingRestore}
      portalContainer={portalRef.current}
      title="从备份恢复？"
      tone="danger"
    />
    <ConfirmDialog
      busy={busy}
      confirmLabel="迁移并重启"
      description="应用会重启，并把现有数据迁移到："
      detail={pendingDataDir}
      onClose={() => setPendingDataDir(null)}
      onConfirm={() => void moveDataDir()}
      open={!!pendingDataDir}
      portalContainer={portalRef.current}
      title="迁移存储位置？"
    />
    <ConfirmDialog
      busy={busy}
      confirmLabel="重启并提权"
      description="MyPaste 会请求 Windows 管理员权限并在成功后重新启动。若在提权提示中取消，应用会继续以当前权限运行。"
      onClose={() => setPendingElevated(false)}
      onConfirm={() => void restartElevated()}
      open={pendingElevated}
      portalContainer={portalRef.current}
      title="以管理员身份重启？"
    />
    <ConfirmDialog
      busy={busy}
      confirmLabel="移到最近删除"
      description={<>所选记录会移入最近删除，7 天后自动清理。</>}
      onClose={() => setBulkDelete(false)}
      onConfirm={() => void batchDelete()}
      open={bulkDelete && checked.size > 0}
      portalContainer={portalRef.current}
      title={`删除所选的 ${checked.size} 条记录？`}
      tone="danger"
    />

    {toast && <div className={cn('toast fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 animate-[toast-in_.18s_ease-out] items-center gap-2 rounded-lg border px-3.5 py-2.5 text-[12px] shadow-lg', toastTone === 'error' ? 'border-destructive/30 bg-[var(--danger-tint)] text-[var(--destructive-foreground)]' : 'border-border bg-card text-foreground')} role={toastTone === 'error' ? 'alert' : 'status'}>
      {toastTone === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}
      {toast}
    </div>}

    <div ref={portalRef} />
  </div>
}
