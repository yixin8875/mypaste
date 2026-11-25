import type { ReactNode } from 'react'
import { ChevronDown, ShieldOff, X } from 'lucide-react'
import type { DbUsage, LogInfo, RuntimeStatus, Settings, Snapshot, UpdateCheck, UpdateProgress } from '@/clipboard-service'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const selectClass = 'h-7.5 appearance-none rounded-md border border-input bg-card pl-2 pr-7 text-[12px] text-foreground outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 sm:h-7.5'

function Row({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('setting-row flex items-start justify-between gap-6 border-b border-border py-3.5 last:border-0', className)}>
      <div className="min-w-0">
        <div className="text-[13px] leading-5 text-foreground">{title}</div>
        {hint && <small className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{hint}</small>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="settings-notice mt-4 rounded-lg border border-border bg-muted/60 px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">{children}</div>
}

function SelectField({ children }: { children: ReactNode }) {
  return (
    <span className="relative inline-flex items-center">
      {children}
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
    </span>
  )
}

export function SettingsDialog({
  open, onClose, tab, onTab, settings, status, snapshot, nativeMode, busy, portalContainer,
  appVersion, updateState, updateInfo, updateProgress, updateError, onCheckUpdates, onInstallUpdate,
  shortcutDraft, onShortcutDraft, onSaveShortcut, onTogglePaused, onToggleAutostart, onRequestElevated, onSettings,
  usage, compacting, onCompact, logInfo, onOpenLogDir, onExportDiagnostics, onExportBackup, onPickRestore, onChooseDataDir, onOpenDataDir,
  appDraft, onAppDraft, onExcludeApp, onRemoveExcluded,
}: {
  open: boolean
  onClose: () => void
  tab: string
  onTab: (value: string) => void
  settings?: Settings
  status?: RuntimeStatus
  snapshot?: Snapshot
  nativeMode: boolean
  busy: boolean
  portalContainer?: HTMLElement | null
  appVersion: string
  updateState: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'error'
  updateInfo: UpdateCheck | null
  updateProgress: UpdateProgress | null
  updateError: string
  onCheckUpdates: () => void
  onInstallUpdate: () => void
  shortcutDraft: string
  onShortcutDraft: (value: string) => void
  onSaveShortcut: () => void
  onTogglePaused: () => void
  onToggleAutostart: () => void
  onRequestElevated: () => void
  onSettings: (patch: Partial<Settings>) => void
  usage: DbUsage | null
  compacting: boolean
  onCompact: () => void
  logInfo: LogInfo | null
  onOpenLogDir: () => void
  onExportDiagnostics: () => void
  onExportBackup: () => void
  onPickRestore: () => void
  onChooseDataDir: () => void
  onOpenDataDir: () => void
  appDraft: string
  onAppDraft: (value: string) => void
  onExcludeApp: (name: string) => void
  onRemoveExcluded: (name: string) => void
}) {
  return (
    <Dialog onOpenChange={next => { if(!next) onClose() }} open={open}>
      <DialogPopup
        aria-label="设置"
        bottomStickOnMobile={false}
        className="settings-modal flex max-h-[min(760px,calc(100dvh-3rem))] w-[620px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0"
        closeProps={{ 'aria-label': '关闭' }}
        portalProps={{ container: portalContainer ?? undefined }}
      >
        <DialogTitle className="px-6 pb-3 pt-5 text-[16px] font-semibold tracking-tight">设置</DialogTitle>
        <Tabs className="flex min-h-0 flex-1 flex-col gap-0" onValueChange={onTab} value={tab}>
          <div className="shrink-0 px-6">
            <TabsList className="settings-tabs w-full justify-start gap-4 border-b border-border bg-transparent p-0" variant="underline">
              {['通用', '历史保留', '数据', '隐私'].map(name => <TabsTab className="after:hidden" key={name} value={name}>{name}</TabsTab>)}
            </TabsList>
          </div>

          <TabsPanel className="settings-body min-h-0 flex-1 overflow-y-auto px-6 py-2" value="通用">
            <Row hint={nativeMode ? status?.shortcutRegistered ? '全局快捷键已注册' : status?.shortcutError ?? '尚未注册' : '浏览器仅在当前页面使用'} title="快捷呼出">
              <div className="shortcut-editor flex items-center gap-2">
                <Input aria-label="全局快捷键" className="w-36 [&_input]:text-[12px]" maxLength={80} onChange={event => onShortcutDraft(event.target.value)} value={shortcutDraft} />
                <Button disabled={!nativeMode || busy || !shortcutDraft.trim()} onClick={onSaveShortcut} size="sm" variant="outline">保存</Button>
              </div>
            </Row>
            <Row hint={nativeMode ? '重启后保持暂停状态' : '此处仅演示状态切换'} title="暂停记录">
              <Switch aria-label="暂停记录" checked={settings?.paused ?? false} disabled={busy || !snapshot} onCheckedChange={onTogglePaused} />
            </Row>
            <Row hint={nativeMode ? '登录 Windows 后自动在托盘运行' : '仅在桌面版可用'} title="开机自动启动">
              <Switch aria-label="开机自动启动" checked={status?.autostart ?? false} disabled={!nativeMode || busy} onCheckedChange={onToggleAutostart} />
            </Row>
            <Row hint={nativeMode ? status?.elevated ? '当前已以管理员身份运行；可粘贴到以管理员身份运行的应用' : '普通权限。部分以管理员身份运行的应用需要提权后才能粘贴' : '仅在桌面版可用'} title="管理员启动">
              <Button disabled={!nativeMode || busy || status?.elevated} onClick={onRequestElevated} size="sm" variant="outline">{status?.elevated ? '已提权' : '以管理员身份重启…'}</Button>
            </Row>
            <Row
              hint={<>
                当前版本 {appVersion || '读取中…'}{!nativeMode ? ' · 浏览器演示不检查更新' : ''}
                {updateState === 'latest' && <span className="block text-[var(--success-foreground)]" role="status">已是最新版本</span>}
                {updateInfo && <span className="block text-[var(--info-foreground)]" role="status">发现新版本 {updateInfo.version}{updateInfo.notes ? `：${updateInfo.notes}` : '，包含修复与改进'}</span>}
                {updateState === 'downloading' && <span className="block" role="status">正在下载{updateProgress?.total ? ` ${Math.min(100, Math.round(updateProgress.downloaded / updateProgress.total * 100))}%` : updateProgress ? ` ${formatBytes(updateProgress.downloaded)}` : '…'}</span>}
                {updateError && <span className="block text-[var(--destructive-foreground)]" role="alert">{updateError}</span>}
              </>}
              title="软件更新"
            >
              {updateInfo
                ? <Button disabled={updateState === 'downloading'} onClick={onInstallUpdate} size="sm" variant="outline">{updateState === 'downloading' ? '正在安装…' : '下载并安装'}</Button>
                : <Button disabled={!nativeMode || updateState === 'checking'} onClick={onCheckUpdates} size="sm" variant="outline">{updateState === 'checking' ? '正在检查…' : '检查更新'}</Button>}
            </Row>
            <Notice>{nativeMode ? '关闭主窗口后仍在托盘运行。请从托盘菜单退出。快捷键被占用时，可以更换组合。' : '这是浏览器演示。使用桌面版体验真实监听、托盘和全局快捷键。'}</Notice>
          </TabsPanel>

          <TabsPanel className="settings-body min-h-0 flex-1 overflow-y-auto px-6 py-2" value="历史保留">
            <Row title="普通记录保留时间">
              <SelectField>
                <select aria-label="保留天数" className={selectClass} disabled={busy || !settings} onChange={event => onSettings({ retentionDays: Number(event.target.value) })} value={settings?.retentionDays ?? 30}>
                  <option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option>
                </select>
              </SelectField>
            </Row>
            <Row title="最大普通历史条数">
              <SelectField>
                <select aria-label="历史条数" className={selectClass} disabled={busy || !settings} onChange={event => onSettings({ maxItems: Number(event.target.value) })} value={settings?.maxItems ?? 500}>
                  <option value={500}>500 条</option><option value={1000}>1,000 条</option><option value={5000}>5,000 条</option>
                </select>
              </SelectField>
            </Row>
            <Notice>{nativeMode ? '设置保存在本机，到期和超量记录进入回收站。' : '演示选择仅保留在当前页面，不执行清理。'}收藏与置顶不参与时间和条数清理；删除内容在回收站保留 7 天。图片单张最多 10 MiB，总计 500 MiB。可在「管理集合」中为单个集合设置更长的保留时间或独立条数上限；记录只要仍被任一集合保留，就不会被清理。</Notice>
          </TabsPanel>

          <TabsPanel className="settings-body min-h-0 flex-1 overflow-y-auto px-6 py-2" value="数据">
            <h4 className="settings-group mb-1 mt-3 border-b border-border pb-1 text-[12px] font-semibold text-muted-foreground first:mt-0">存储</h4>
            {snapshot?.storageError && <p className="setting-error mt-2 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-[var(--destructive-foreground)]" role="alert">存储迁移未完成：{snapshot.storageError}（仍使用原路径）</p>}
            <Row hint={<span className="data-path break-all">{nativeMode ? `${snapshot?.dataDir || '正在读取目录…'}${status?.portable ? '（便携模式）' : ''}` : '浏览器演示不写入磁盘'}</span>} title="本地存储位置">
              <Button disabled={!nativeMode || busy} onClick={onOpenDataDir} size="sm" variant="outline">打开文件夹</Button>
              <Button disabled={!nativeMode || busy} onClick={onChooseDataDir} size="sm" variant="outline">更改…</Button>
            </Row>
            <h4 className="settings-group mb-1 mt-4 border-b border-border pb-1 text-[12px] font-semibold text-muted-foreground">备份</h4>
            <Row hint="导出单个 .sqlite3 文件；恢复会替换当前全部记录，设置保留。" title="备份与恢复">
              <Button disabled={!nativeMode || busy || !snapshot} onClick={onExportBackup} size="sm" variant="outline">导出备份</Button>
              <Button disabled={!nativeMode || busy || !snapshot} onClick={onPickRestore} size="sm" variant="outline">从备份恢复…</Button>
            </Row>
            <h4 className="settings-group mb-1 mt-4 border-b border-border pb-1 text-[12px] font-semibold text-muted-foreground">维护与诊断</h4>
            <Row hint={usage ? `${usage.bytes > 0 ? `${formatBytes(usage.bytes)} · ` : ''}${usage.items} 条记录，回收站 ${usage.trashed} 条${nativeMode ? '' : '（演示）'}` : nativeMode ? '正在读取…' : '浏览器演示不写入磁盘'} title="数据库占用">
              <Button disabled={!nativeMode || busy || compacting} onClick={onCompact} size="sm" variant="outline">{compacting ? '正在整理…' : '整理数据库'}</Button>
            </Row>
            <Row hint={<span className="data-path break-all">{nativeMode ? logInfo ? `${logInfo.file || 'logs/mypaste.log'}${logInfo.bytes ? ` · ${formatBytes(logInfo.bytes)}` : ''}` : '正在读取…' : '浏览器演示不写入日志'}<span className="mt-1 block">只记录操作与错误，不记录剪贴板内容、搜索词或窗口标题；达到 1 MiB 后轮换，保留最近 3 个。</span></span>} title="诊断日志">
              <Button disabled={!nativeMode} onClick={onOpenLogDir} size="sm" variant="outline">打开日志目录</Button>
              <Button disabled={!nativeMode || busy} onClick={onExportDiagnostics} size="sm" variant="outline">导出诊断信息…</Button>
            </Row>
            <Notice>更改位置后应用会重启，并把 history.sqlite3 迁移到新目录，复制成功后才删除旧文件。备份文件未加密，请妥善保管。</Notice>
          </TabsPanel>

          <TabsPanel className="settings-body min-h-0 flex-1 overflow-y-auto px-6 py-2" value="隐私">
            <div className="exclude-block py-3">
              <h4 className="text-[13px] font-medium text-foreground">不记录这些应用的内容</h4>
              <p className="form-help mt-1 text-[11px] leading-5 text-muted-foreground">切换窗口时，来自这些应用的复制内容会在读取前被跳过，不会写入历史。</p>
              <form className="exclude-add mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); onExcludeApp(appDraft) }}>
                <Input aria-label="排除的应用名称" className="flex-1 [&_input]:text-[12px]" maxLength={120} onChange={event => onAppDraft(event.target.value)} placeholder="应用名，例如 KeePassXC" value={appDraft} />
                <Button disabled={busy || !appDraft.trim()} size="sm" type="submit" variant="outline">添加</Button>
              </form>
              {(settings?.excludedApps.length ?? 0) > 0
                ? <div className="exclude-list mt-3 flex flex-wrap gap-1.5">{settings!.excludedApps.map(name => (
                  <span className="exclude-chip inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card px-1.5 text-[11px] text-foreground" key={name}>
                    <ShieldOff className="text-muted-foreground" size={11} />{name}
                    <button aria-label={`恢复记录来自 ${name} 的内容`} className="ml-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={busy} onClick={() => onRemoveExcluded(name)} type="button"><X size={11} /></button>
                  </span>
                ))}</div>
                : <p className="empty-inline mt-3 text-[11px] text-muted-foreground">尚未排除任何应用。</p>}
            </div>
            <Notice>本地存储不等同于加密保险箱。排除规则在读取剪贴板前生效；来源识别失败时无法匹配，因此不能承诺拦截所有敏感内容。处理密码或密钥前，仍建议暂停记录。</Notice>
          </TabsPanel>
        </Tabs>

        <div className="modal-actions flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/40 px-6 py-3">
          <Button className="primary-button" onClick={onClose}>完成</Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
