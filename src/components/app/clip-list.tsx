import type { KeyboardEvent, MouseEvent, RefObject } from 'react'
import { Check, ChevronDown, Copy, Folder, Keyboard, Monitor, Pin, Play, Search, Star, Trash2, X } from 'lucide-react'
import type { Clip, Kind, SequenceStatus } from '@/clipboard-service'
import { cn } from '@/lib/utils'
import { dayOf, fileSummary, imageFile } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { IconButton, Thumb, TypeIcon } from './shared'

const tileTone: Record<Kind, string> = {
  text: 'bg-[#edf1f9] text-[#3c5687]',
  link: 'bg-[#e7f2f0] text-[#2f6b64]',
  image: 'bg-[#f1ebf8] text-[#6c4b8f]',
  file: 'bg-[#fbf0e4] text-[#8a5c26]',
}

export function TypeTile({ type, size = 'md' }: { type: Kind; size?: 'md' | 'lg' }) {
  return <div className={cn('type-tile grid shrink-0 place-items-center rounded-lg', tileTone[type], size === 'md' ? 'size-9' : 'size-11')}><TypeIcon size={size === 'md' ? 18 : 22} type={type} /></div>
}

export function ClipList({
  heading, nav, visible, navScopeCount, filtered, query, onQuery, searchRef, sourceFilter, onSourceFilter, sources, collections,
  loading, searching, summaryId, checked, onSelectRow, onListKeyDown, busy, paused, nativeMode,
  onOpenQuick, onBatchPatch, onBatchAdd, onStartSequence, onRequestBulkDelete, onClearChecked,
  sequence, shortcut, onNextSequence, onStopSequence, onClearFilters,
}: {
  heading: string
  nav: string
  visible: Clip[]
  navScopeCount: number
  filtered: boolean
  query: string
  onQuery: (value: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  sourceFilter: string
  onSourceFilter: (value: string) => void
  sources: string[]
  collections: string[]
  loading: boolean
  searching: boolean
  summaryId?: number
  checked: Set<number>
  onSelectRow: (clip: Clip, event: MouseEvent) => void
  onListKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  busy: boolean
  paused: boolean
  nativeMode: boolean
  onOpenQuick: () => void
  onBatchPatch: (patch: { favorite?: boolean; pinned?: boolean }, message: string) => void
  onBatchAdd: (name: string) => void
  onStartSequence: () => void
  onRequestBulkDelete: () => void
  onClearChecked: () => void
  sequence?: SequenceStatus
  shortcut: string
  onNextSequence: () => void
  onStopSequence: () => void
  onClearFilters: () => void
}) {
  return (
    <section aria-label="剪贴记录" className="flex w-[336px] shrink-0 flex-col border-r border-border bg-background max-[1150px]:w-[310px] max-[680px]:h-[420px] max-[680px]:w-full max-[680px]:border-b max-[680px]:border-r-0">
      <div className="list-heading flex shrink-0 items-end justify-between gap-2 px-3.5 pt-4">
        <div className="min-w-0">
          <h1 className="truncate text-[21px] font-semibold tracking-[-0.01em] text-foreground max-[1150px]:text-[20px]">{heading}</h1>
          <span className="mt-1 block text-[12px] text-muted-foreground">
            {visible.length} 条记录
            {(nav === '最近删除' || filtered) && <><span className="mx-1.5">·</span>{nav === '最近删除' ? '7 天后自动清理' : `此分类共 ${navScopeCount} 条`}</>}
          </span>
        </div>
        <IconButton label="查看快捷窗口" onClick={onOpenQuick}><Keyboard size={17} /></IconButton>
      </div>

      <div className="relative mx-3.5 mt-3 shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="搜索记录"
          className="[&_input]:pl-8 [&_input]:pr-16"
          maxLength={1000}
          onChange={e => onQuery(e.target.value)}
          placeholder="搜索剪贴记录"
          ref={searchRef}
          value={query}
        />
        {query
          ? <button aria-label="清空搜索" className="absolute right-2 top-1/2 z-10 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => onQuery('')} type="button"><X size={14} /></button>
          : <Kbd className="pointer-events-none absolute right-2 top-1/2 z-10 -translate-y-1/2 bg-card">Ctrl K</Kbd>}
      </div>

      <div className="flex shrink-0 items-center justify-between px-3.5 py-2.5">
        <label className="relative inline-flex items-center">
          <select
            aria-label="来源应用筛选"
            className="h-7 appearance-none rounded-md border border-input bg-card pl-2 pr-7 text-[12px] text-foreground outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/40"
            onChange={e => onSourceFilter(e.target.value)}
            value={sourceFilter}
          >
            <option value="all">所有来源</option>
            {sources.map(source => <option key={source} value={source}>{source}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
        </label>
        <span className="text-[11px] text-muted-foreground">{busy ? '正在保存…' : '按最近复制'}</span>
      </div>

      {checked.size > 0 && nav !== '最近删除' && (
        <div className="bulk-bar mx-3.5 mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 shadow-xs" role="region" aria-label="批量操作">
          <span className="bulk-count whitespace-nowrap text-[12px] font-medium text-foreground">已选择 {checked.size} 项</span>
          <div className="bulk-actions ml-auto flex flex-wrap items-center gap-0.5">
            <Button disabled={busy} onClick={() => onBatchPatch({ favorite: true }, '已收藏所选记录')} size="xs" variant="ghost"><Star />收藏</Button>
            <Button disabled={busy} onClick={() => onBatchPatch({ pinned: true }, '已置顶所选记录')} size="xs" title="按选择顺序逐条复制，适合连续填写多个字段" variant="ghost"><Pin />置顶</Button>
            <Button disabled={busy} onClick={onStartSequence} size="xs" title="按选择顺序逐条复制，适合连续填写多个字段" variant="ghost"><Play />序列粘贴</Button>
            <label className="bulk-collection relative inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <Folder size={13} />
              <select
                aria-label="加入集合"
                className="appearance-none bg-transparent pr-4 text-[12px] text-foreground outline-none disabled:opacity-50"
                disabled={busy}
                onChange={e => { if(e.target.value) onBatchAdd(e.target.value) }}
                value=""
              >
                <option value="">加入集合…</option>
                {collections.map(name => <option key={name}>{name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 size-3" />
            </label>
            <Button className="text-destructive-foreground hover:text-destructive-foreground" disabled={busy} onClick={onRequestBulkDelete} size="xs" variant="ghost"><Trash2 />删除</Button>
            <Button onClick={onClearChecked} size="xs" variant="ghost"><X />取消选择</Button>
          </div>
        </div>
      )}

      {sequence?.active && (
        <div className="sequence-bar mx-3.5 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-primary/20 bg-[var(--accent-tint)] px-2.5 py-2" role="status">
          <div className="sequence-info flex min-w-0 flex-1 items-center gap-2">
            <Play className="size-3.5 shrink-0 text-primary" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-[12px] font-medium text-foreground">序列粘贴 {sequence.position}/{sequence.total}</strong>
              <span className="truncate text-[11px] text-muted-foreground">当前：{sequence.currentTitle ?? '未命名记录'} · 剩余 {sequence.remaining} 条 · 按 {shortcut} 粘贴下一项</span>
            </div>
          </div>
          <div className="sequence-actions flex shrink-0 items-center gap-0.5">
            <Button disabled={busy} onClick={onNextSequence} size="xs" title="仅复制下一项，不发送粘贴快捷键" variant="outline"><Copy />下一项</Button>
            <Button disabled={busy} onClick={onStopSequence} size="xs" variant="ghost">结束</Button>
          </div>
        </div>
      )}

      <div className="clip-list scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3" onKeyDown={onListKeyDown}>
        {(loading || searching) && <div className="list-empty px-4 py-10 text-center text-[13px] text-muted-foreground" role="status">{loading ? '正在读取记录…' : '正在搜索…'}</div>}
        {!loading && !searching && visible.length === 0 && (
          <div className="list-empty flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Search className="size-6 text-muted-foreground/60" />
            <strong className="text-[13px] font-medium text-foreground">{visible.length === 0 && !query && navScopeCount === 0 ? '复制一段内容，从这里开始' : '没有找到相关记录'}</strong>
            <span className="text-[12px] text-muted-foreground">{nativeMode && navScopeCount === 0 ? '文本、链接、图片与文件会自动出现在这里' : '试试其他关键词或来源'}</span>
            {(query || sourceFilter !== 'all') && <button className="text-[12px] text-primary hover:underline" onClick={onClearFilters} type="button">清除筛选</button>}
          </div>
        )}
        {visible.map((clip, index) => {
          const isSelected = summaryId === clip.id, isChecked = checked.has(clip.id)
          return (
            <div key={clip.id}>
              {(index === 0 || dayOf(visible[index - 1]) !== dayOf(clip)) && (
                <div className="date-group flex items-center justify-between px-2.5 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
                  {dayOf(clip)}<span>{new Date(clip.capturedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span>
                </div>
              )}
              <button
                aria-pressed={isChecked}
                className={cn(
                  'clip-row group relative flex min-h-[68px] w-full items-start gap-2.5 rounded-lg border border-transparent px-2 py-2.5 text-left transition-[background-color,border-color,box-shadow] hover:bg-accent/70',
                  isChecked && 'row-checked border-primary/25 bg-[var(--accent-tint)]',
                  isSelected && 'row-selected border-border bg-card shadow-xs',
                  isChecked && isSelected && 'bg-card',
                )}
                onClick={event => onSelectRow(clip, event)}
                onMouseDown={event => { if(event.shiftKey) event.preventDefault() }}
                type="button"
              >
                {isSelected && <span className="absolute inset-y-3 left-0 w-[2px] rounded-full bg-primary" />}
                <span className={cn('row-check mt-3 grid size-4 shrink-0 place-items-center rounded-[4px] border border-[var(--paper-line-strong)] bg-card text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100', isChecked && 'is-checked border-primary bg-primary opacity-100')} aria-hidden="true">
                  {isChecked && <Check size={11} strokeWidth={3} />}
                </span>
                {clip.type === 'image' || imageFile(clip) ? <Thumb clip={clip} /> : <TypeTile type={clip.type} />}
                <div className="clip-row-text min-w-0 flex-1">
                  <div className="clip-row-title truncate pr-8 text-[13px] font-medium leading-5 text-foreground">{clip.title || '未命名记录'}</div>
                  <p className="mt-0.5 truncate text-[12px] leading-4.5 text-muted-foreground">
                    {clip.type === 'image' ? nativeMode ? '图片' : '图片 · 设计示例' : clip.type === 'file' ? fileSummary(clip.content, clip.fileSize) : clip.content.replace(/\n/g, ' ')}
                  </p>
                  <div className="row-meta mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="truncate">{clip.source}</span>
                    <span className="row-time ml-auto shrink-0 font-mono tabular-nums">{clip.time}</span>
                  </div>
                </div>
                {(clip.pinned || clip.favorite) && (
                  <span className="row-badges absolute right-2 top-2 flex gap-1 text-[var(--star)]">
                    {clip.pinned && <Pin fill="currentColor" size={11} />}
                    {clip.favorite && <Star fill="currentColor" size={11} />}
                  </span>
                )}
              </button>
            </div>
          )
        })}
      </div>

      <div className="list-footer flex h-8 shrink-0 items-center justify-between border-t border-border px-3.5 text-[11px] text-muted-foreground">
        <span>{paused ? '已暂停采集' : nativeMode ? '所有内容仅保存在本地' : '虚构数据 · 刷新重置'}</span>
        <Monitor size={13} />
      </div>
    </section>
  )
}
