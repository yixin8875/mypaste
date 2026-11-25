import { useEffect, useState } from 'react'
import { AlertCircle, ArrowUpRight, ChevronDown, Copy, Folder, FolderOpen, Link2, Pin, PinOff, RotateCcw, ShieldCheck, ShieldOff, Star, Trash2, X } from 'lucide-react'
import type { Clip, ClipPatch, CopyMode, RichFormat } from '@/clipboard-service'
import { cn } from '@/lib/utils'
import { baseName, dayOf, FILE_WARN, fileEntries, formatBytes, formatModified, hostname, imageFile } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Editable, IconButton, Picture, type DraftStore } from './shared'
import { TypeTile } from './clip-list'

const formatBadge = 'inline-flex h-5 items-center rounded border border-border bg-card px-1.5 text-[11px] text-muted-foreground'

export function ClipDetail({
  selected, detail, detailError, loading, busy, nativeMode, copying, drafts, collections, portalContainer,
  onUpdate, onCopy, onOpenLink, onCopyVariant, onCopyFormat, onDelete, onRestore, onRequestPurge, onExcludeApp,
}: {
  selected?: Clip
  detail: Clip | null
  detailError: string
  loading: boolean
  busy: boolean
  nativeMode: boolean
  copying: boolean
  drafts: DraftStore
  collections: string[]
  portalContainer?: HTMLElement | null
  onUpdate: (id: number, patch: ClipPatch) => Promise<boolean>
  onCopy: (clip: Clip) => void
  onOpenLink: (clip: Clip) => void
  onCopyVariant: (clip: Clip, mode: CopyMode) => void
  onCopyFormat: (clip: Clip, format: RichFormat) => void
  onDelete: (id: number) => void
  onRestore: (id: number) => void
  onRequestPurge: (id: number) => void
  onExcludeApp: (name: string) => void
}) {
  const [copyMenu, setCopyMenu] = useState(false)
  useEffect(() => { setCopyMenu(false) }, [selected?.id])

  if(!selected) {
    return (
      <section aria-label="记录详情" className="detail-pane flex min-w-0 flex-1 flex-col" tabIndex={-1}>
        <div className="detail-empty flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
          <div className="empty-illustration grid size-14 place-items-center rounded-xl border border-border bg-card text-muted-foreground shadow-sm">
            <FolderOpen size={28} />
          </div>
          <h2 className="mt-2 text-[17px] font-medium text-foreground">{loading ? '正在读取记录' : '还没有选中记录'}</h2>
          <p className="text-[12px] text-muted-foreground">{loading ? '正在连接本地数据' : '左侧列表里的内容会在这里展开'}</p>
        </div>
      </section>
    )
  }

  const content = detail ?? selected
  const isCode = content.content.startsWith('import ')

  return (
    <section aria-label="记录详情" className="detail-pane flex min-w-0 flex-1 flex-col bg-background" tabIndex={-1}>
      <div className="detail-scroll scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="detail-content mx-auto w-full max-w-[810px] px-8 py-8 max-[1150px]:px-6 max-[680px]:px-5">
          <TypeTile size="lg" type={selected.type} />
          <div className="detail-title-row mt-4 flex flex-wrap items-start gap-3">
            <h2 className="min-w-0 flex-1 text-[24px] font-semibold leading-[1.3] tracking-[-0.015em] text-foreground max-[1150px]:text-[22px] max-[950px]:text-[21px]">{selected.title || '未命名记录'}</h2>
            <div className="detail-title-actions flex shrink-0 items-center gap-0.5">
              {!selected.deleted && <>
                <IconButton active={selected.pinned} disabled={busy} label={selected.pinned ? '取消置顶' : '置顶记录'} onClick={() => void onUpdate(selected.id, { pinned: !selected.pinned })}>{selected.pinned ? <PinOff size={17} /> : <Pin size={17} />}</IconButton>
                <IconButton active={selected.favorite} disabled={busy} label={selected.favorite ? '取消收藏' : '收藏记录'} onClick={() => void onUpdate(selected.id, { favorite: !selected.favorite })}><Star fill={selected.favorite ? 'currentColor' : 'none'} size={17} /></IconButton>
              </>}
              {selected.deleted
                ? <IconButton disabled={busy} label="恢复记录" onClick={() => onRestore(selected.id)}><RotateCcw size={17} /></IconButton>
                : <IconButton disabled={busy} label="删除记录" onClick={() => onDelete(selected.id)}><Trash2 size={17} /></IconButton>}
            </div>
          </div>
          <div className="detail-subtitle mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            来自 {selected.source}<span>·</span>{dayOf(selected)} {selected.time}
          </div>

          <div className="mt-6">
            {selected.type === 'image'
              ? <Picture clip={selected} key={selected.id} />
              : !detail
                ? <div className="text-preview paper-sheet p-6 text-[13px] text-muted-foreground"><pre>{detailError ? '内容读取失败，请重新加载。' : '正在读取完整内容…'}</pre></div>
                : selected.type === 'link'
                  ? <div className="link-preview paper-sheet flex items-center gap-3 p-4">
                    <div className="link-site-icon grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--accent-tint)] text-primary"><Link2 size={20} /></div>
                    <div className="min-w-0 flex-1"><strong className="block truncate text-[14px] font-medium text-foreground">{selected.title}</strong><span className="mt-0.5 block truncate text-[12px] text-muted-foreground">{hostname(selected.content)}</span></div>
                    <IconButton label="在浏览器打开链接" onClick={() => onOpenLink(selected)}><ArrowUpRight size={17} /></IconButton>
                  </div>
                  : selected.type === 'file'
                    ? <div className="file-preview paper-sheet overflow-hidden">
                      <div className="flex items-center justify-between border-b border-border px-4 py-3 text-[12px] text-muted-foreground">
                        <span className="font-medium text-foreground">文件与文件夹</span>
                        <span>{fileEntries(selected).length} 项{selected.fileSize > 0 ? ` · ${formatBytes(selected.fileSize)}` : ''}</span>
                      </div>
                      {imageFile(selected) && <div className="p-3"><Picture clip={selected} key={`${selected.id}-file`} /></div>}
                      {selected.fileSize >= FILE_WARN && <div className="file-warning mx-3 mt-3 flex gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-[var(--warning-foreground)]" role="status"><AlertCircle className="mt-0.5 size-3.5 shrink-0" /><span>总大小达到 1 GB。复制记录只写入路径；粘贴时由目标应用实际复制，可能耗时并占用磁盘。</span></div>}
                      <div className="file-rows scroll-thin max-h-[360px] overflow-y-auto px-2 py-2">
                        {fileEntries(selected).map((entry, index) => (
                          <div className="file-row flex gap-2.5 rounded-md px-2 py-2 hover:bg-accent/60" key={`${index}-${entry.path}`}>
                            <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <strong className="truncate text-[13px] font-medium text-foreground">{baseName(entry.path)}</strong>
                              <span className="break-all text-[11px] text-muted-foreground">{entry.path}</span>
                              <em className="text-[11px] not-italic text-muted-foreground">{entry.isDir ? '文件夹' : entry.size === null ? '大小未知' : formatBytes(entry.size)}{entry.modifiedAt !== null ? ` · ${formatModified(entry.modifiedAt)}` : ''}</em>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    : <div className={cn('text-preview paper-sheet p-5', isCode && 'code-preview')}>
                      <div className="preview-label mb-3 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                        {isCode ? '代码 / 纯文本' : '纯文本'}<span className="ml-auto font-mono tabular-nums">{[...selected.content].length} 字符</span>
                      </div>
                      <pre className="text-[13px] leading-[1.75] text-foreground">{selected.content}</pre>
                    </div>}
          </div>

          <div className="primary-actions mt-5 flex flex-wrap items-center gap-2">
            {selected.deleted ? <>
              <Button className="primary-button" disabled={busy} onClick={() => onRestore(selected.id)}><RotateCcw />恢复记录</Button>
              <Button className="danger-button" disabled={busy} onClick={() => onRequestPurge(selected.id)} variant="destructive-outline">彻底删除</Button>
            </> : <>
              <Button className="primary-button" disabled={copying} onClick={() => onCopy(selected)}><Copy />{copying ? '正在复制…' : selected.type === 'file' ? '复制文件' : '复制内容'}</Button>
              {selected.type === 'link' && <Button className="secondary-button" onClick={() => onOpenLink(selected)} variant="outline">打开链接<ArrowUpRight /></Button>}
              {(selected.type === 'text' || selected.type === 'link') && <div className="copy-menu-wrap relative">
                {copyMenu && <div className="copy-menu-backdrop fixed inset-0 z-40" onClick={() => setCopyMenu(false)} />}
                <Menu onOpenChange={setCopyMenu} open={copyMenu}>
                  <MenuTrigger render={<Button aria-expanded={copyMenu} aria-haspopup="menu" className="secondary-button" variant="outline">复制为<ChevronDown /></Button>} />
                  <MenuPopup align="start" className="copy-menu z-50 w-64" portalProps={{ container: portalContainer ?? undefined }}>
                    {selected.hasHtml && <MenuItem className="copy-menu-item flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-[13px] text-foreground data-highlighted:bg-accent" onClick={() => onCopyFormat(selected, 'html')} render={<button type="button" />}>HTML 格式<small className="text-[11px] text-muted-foreground">保留粗体、链接与排版</small></MenuItem>}
                    {selected.hasRtf && <MenuItem className="copy-menu-item flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-[13px] text-foreground data-highlighted:bg-accent" onClick={() => onCopyFormat(selected, 'rtf')} render={<button type="button" />}>RTF 格式<small className="text-[11px] text-muted-foreground">适合粘贴到 Word 等编辑器</small></MenuItem>}
                    <MenuItem className="copy-menu-item flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-[13px] text-foreground data-highlighted:bg-accent" onClick={() => onCopyVariant(selected, 'plain')} render={<button type="button" />}>纯文本<small className="text-[11px] text-muted-foreground">按原样写入剪贴板</small></MenuItem>
                    <MenuItem className="copy-menu-item flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-[13px] text-foreground data-highlighted:bg-accent" onClick={() => onCopyVariant(selected, 'trim')} render={<button type="button" />}>去除首尾空白<small className="text-[11px] text-muted-foreground">适合粘贴到表单或搜索框</small></MenuItem>
                    <MenuItem className="copy-menu-item flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-[13px] text-foreground data-highlighted:bg-accent" onClick={() => onCopyVariant(selected, 'one_line')} render={<button type="button" />}>合并为单行<small className="text-[11px] text-muted-foreground">换行替换为空格</small></MenuItem>
                  </MenuPopup>
                </Menu>
              </div>}
              <span className="action-hint ml-0.5 text-[12px] text-muted-foreground max-[1150px]:hidden">{selected.type === 'file' ? '粘贴到资源管理器' : '粘贴到任意应用'}</span>
            </>}
          </div>

          <div className="info-section mt-8">
            <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">记录信息</h3>
            <div className="divide-y divide-border border-y border-border">
              <div className="info-row flex items-start gap-3 py-2">
                <span className="w-20 shrink-0 pt-1.5 text-[12px] text-muted-foreground">名称</span>
                <Editable cache={drafts} cacheKey={`title-${selected.id}`} disabled={selected.deleted} key={`title-${selected.id}`} label="记录名称" maxLength={200} save={value => onUpdate(selected.id, { title: value })} value={selected.title} />
              </div>
              <div className="info-row flex items-start gap-3 py-2.5">
                <span className="w-20 shrink-0 pt-0.5 text-[12px] text-muted-foreground">来源应用</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-foreground">
                  <span className="truncate">{selected.source}</span>
                  {selected.source !== '未知来源' && <button className="exclude-link inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-primary disabled:opacity-50" disabled={busy || selected.deleted} onClick={() => onExcludeApp(selected.source)} title={`不再记录来自 ${selected.source} 的内容`} type="button"><ShieldOff size={12} />排除此应用</button>}
                </div>
              </div>
              <div className="info-row flex items-start gap-3 py-2.5">
                <span className="w-20 shrink-0 text-[12px] text-muted-foreground">复制时间</span>
                <div className="text-[13px] text-foreground">{new Date(selected.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
              </div>
              {(selected.type === 'text' || selected.type === 'link') && <div className="info-row flex items-start gap-3 py-2.5">
                <span className="w-20 shrink-0 text-[12px] text-muted-foreground">保存格式</span>
                <div className="format-badges flex flex-wrap gap-1"><span className={formatBadge}>纯文本</span>{selected.hasHtml && <span className={formatBadge}>HTML</span>}{selected.hasRtf && <span className={formatBadge}>RTF</span>}</div>
              </div>}
              {selected.type === 'file' && <>
                <div className="info-row flex items-start gap-3 py-2.5"><span className="w-20 shrink-0 text-[12px] text-muted-foreground">总大小</span><div className="text-[13px] text-foreground">{selected.fileSize > 0 ? formatBytes(selected.fileSize) : '未知或空文件夹'}</div></div>
                <div className="info-row flex items-start gap-3 py-2.5"><span className="w-20 shrink-0 text-[12px] text-muted-foreground">最近修改</span><div className="text-[13px] text-foreground">{formatModified(selected.fileModifiedAt)}</div></div>
              </>}
              <div className="info-row collections-row flex items-start gap-3 py-2.5">
                <span className="w-20 shrink-0 pt-1 text-[12px] text-muted-foreground">所属集合</span>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {selected.collections.map(name => (
                    <button className="collection-chip inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card px-1.5 text-[11px] text-foreground transition-colors hover:border-primary/50 disabled:opacity-50" disabled={selected.deleted || busy} key={name} onClick={() => void onUpdate(selected.id, { collections: selected.collections.filter(item => item !== name) })} title={`从${name}移除`} type="button"><Folder size={11} />{name}<X className="text-muted-foreground" size={11} /></button>
                  ))}
                  {!selected.deleted && <select aria-label="加入集合" className="h-6 appearance-none rounded-md border border-dashed border-input bg-transparent px-1.5 text-[11px] text-muted-foreground outline-none hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/40" disabled={busy} onChange={e => { if(e.target.value) void onUpdate(selected.id, { collections: [...selected.collections, e.target.value] }) }} value="">
                    <option value="">＋ 加入集合</option>
                    {collections.filter(name => !selected.collections.includes(name)).map(name => <option key={name}>{name}</option>)}
                  </select>}
                </div>
              </div>
            </div>
          </div>

          <div className="note-section mt-6">
            <h3 className="mb-2 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">备注<span className="font-normal">{busy ? '正在保存…' : '失焦后自动保存'}</span></h3>
            <Editable cache={drafts} cacheKey={`note-${selected.id}`} disabled={selected.deleted} key={`note-${selected.id}`} label="备注" maxLength={10000} multiline save={value => onUpdate(selected.id, { note: value })} value={selected.note} />
          </div>
        </div>
      </div>
      <div className="detail-footer flex h-8 shrink-0 items-center gap-1.5 border-t border-border px-6 text-[11px] text-muted-foreground">
        <ShieldCheck size={13} /><span>{nativeMode ? '仅保存在本机' : '浏览器演示使用虚构内容'}</span>
      </div>
    </section>
  )
}
