import { useEffect, useState } from 'react'
import { AlertCircle, ArrowDown, ChevronDown, Folder, Pin, Search, X, Zap } from 'lucide-react'
import type { Clip, Kind } from '@/clipboard-service'
import { cn } from '@/lib/utils'
import { fileSummary, imageFile, typeNames } from '@/lib/format'
import { useSearchIds } from '@/use-clipboard'
import { Dialog, DialogPopup } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { IconButton, StatusDot, Thumb } from './shared'
import { TypeTile } from './clip-list'

type QuickKind = 'all' | Kind

function QuickPanel({ quickOnly, dragging, active, collections, revision, copying, nativeMode, shortcut, notice, onCopy, onClose }: {
  quickOnly: boolean
  dragging: boolean
  active: Clip[]
  collections: string[]
  revision: number
  copying: boolean
  nativeMode: boolean
  shortcut: string
  notice: string
  onCopy: (clip: Clip, close?: boolean, paste?: boolean) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [kind, setKind] = useState<QuickKind>('all')
  const [collection, setCollection] = useState('all')
  const [sort, setSort] = useState<'recent' | 'used'>('recent')
  const search = useSearchIds(query, revision)

  const matches = active.filter(clip => (kind === 'all' || clip.type === kind) && (collection === 'all' || clip.collections.includes(collection)) && (!search.ids || search.ids.has(clip.id)))
  const items = [...matches].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (sort === 'used' ? (b.useCount - a.useCount || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.capturedAt - a.capturedAt) : b.capturedAt - a.capturedAt))
  const selected = items[Math.min(index, Math.max(0, items.length - 1))]

  useEffect(() => { setQuery(''); setIndex(0) }, [])
  useEffect(() => { document.getElementById(`quick-${selected?.id}`)?.scrollIntoView({ block: 'nearest' }) }, [selected?.id])

  useEffect(() => {
    if(!quickOnly) return
    const onKey = (event: KeyboardEvent) => { if(event.key === 'Escape') { event.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quickOnly, onClose])

  return (
    <div className={cn('flex min-h-0 flex-col', quickOnly && 'h-full')}>
      <div className="flex h-10 shrink-0 items-center justify-between px-4" data-tauri-drag-region={dragging ? '' : undefined}>
        <span className="text-[11px] text-muted-foreground" data-tauri-drag-region={dragging ? '' : undefined}>快捷窗口</span>
        <IconButton className="-mr-1.5" label="关闭" onClick={onClose}><X size={16} /></IconButton>
      </div>

      <div className={cn('relative shrink-0 px-4 pb-2', quickOnly && 'mx-auto w-full max-w-[880px] px-6 pt-4')}>
        <Search className={cn('pointer-events-none absolute top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground', quickOnly ? 'left-9' : 'left-7')} />
        <Input
          aria-activedescendant={selected ? `quick-${selected.id}` : undefined}
          aria-autocomplete="list"
          aria-controls="quick-results"
          aria-expanded="true"
          aria-label="快捷搜索"
          className="quick-search h-11 rounded-xl border-input bg-card shadow-sm [&_input]:pl-9 [&_input]:pr-14 [&_input]:text-[15px]"
          maxLength={1000}
          onChange={event => { setQuery(event.target.value); setIndex(0) }}
          onKeyDown={event => {
            if(event.key === 'ArrowDown') { event.preventDefault(); setIndex(current => Math.min(current + 1, Math.max(0, items.length - 1))) }
            if(event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(0, current - 1)) }
            if(event.key === 'Enter' && selected) { event.preventDefault(); onCopy(selected, true, event.ctrlKey) }
          }}
          placeholder="搜索记录"
          role="combobox"
          value={query}
        />
        <Kbd className={cn('pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 bg-card', quickOnly ? 'right-9' : 'right-7')}>Esc</Kbd>
      </div>

      <div className={cn('quick-filters flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2', quickOnly && 'mx-auto w-full max-w-[880px] px-6')}>
        <div className="quick-chips flex flex-wrap gap-1" role="group" aria-label="快捷筛选">
          {(['all', 'text', 'link', 'image', 'file'] as const).map(type => (
            <button
              aria-pressed={kind === type}
              className={cn('quick-chip h-6.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', kind === type && 'active border border-border bg-card text-foreground shadow-xs')}
              key={type}
              onClick={() => { setKind(type); setIndex(0) }}
              type="button"
            >
              {type === 'all' ? '全部' : typeNames[type]}
            </button>
          ))}
        </div>
        <label className="quick-select relative ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-muted-foreground" title="按集合筛选">
          <Folder size={12} />
          <select
            aria-label="集合筛选"
            className="appearance-none bg-transparent pr-4 text-[11px] text-foreground outline-none"
            onChange={event => { setCollection(event.target.value); setIndex(0) }}
            value={collection}
          >
            <option value="all">所有集合</option>
            {collections.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 size-3" />
        </label>
      </div>

      {notice && <div className="quick-notice mx-4 mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-[var(--warning-foreground)]" role="status"><AlertCircle className="mt-0.5 size-3.5 shrink-0" /><span>{notice}</span></div>}

      <div className="quick-list-head flex shrink-0 items-center justify-between px-4 pb-1">
        <div className="quick-list-title flex items-center gap-2 text-[11px] text-muted-foreground">
          <strong className="font-medium text-foreground">{query ? '搜索结果' : '记录'}</strong><span className="font-mono tabular-nums">{items.length} 条</span>
        </div>
        <button className="quick-sort inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={() => { setSort(current => current === 'recent' ? 'used' : 'recent'); setIndex(0) }} title="切换排序方式" type="button">
          {sort === 'recent' ? <><ArrowDown size={12} />最近复制</> : <><Zap size={12} />最常使用</>}
        </button>
      </div>

      <div className={cn('quick-results scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3', quickOnly ? 'mx-auto w-full max-w-[880px]' : 'max-h-[380px]')} id="quick-results" role="listbox" aria-label="快捷搜索结果">
        {items.length === 0 && <div className="list-empty px-4 py-8 text-center text-[13px] text-muted-foreground">{search.loading ? '正在搜索…' : '没有找到相关记录'}{!search.loading && (kind !== 'all' || collection !== 'all') && <button className="ml-2 text-primary hover:underline" onClick={() => { setKind('all'); setCollection('all') }} type="button">清除筛选</button>}</div>}
        {items.map((clip, position) => (
          <button
            aria-selected={selected?.id === clip.id}
            className={cn('quick-row flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent/70', selected?.id === clip.id && 'active border-border bg-card shadow-xs')}
            disabled={copying}
            id={`quick-${clip.id}`}
            key={clip.id}
            onClick={() => { setIndex(position); onCopy(clip, true) }}
            onFocus={() => setIndex(position)}
            role="option"
            type="button"
          >
            {clip.type === 'image' || imageFile(clip) ? <Thumb clip={clip} /> : <TypeTile type={clip.type} />}
            <div className="min-w-0 flex-1">
              <strong className="flex items-center gap-1 truncate text-[13px] font-medium text-foreground">{clip.pinned && <Pin className="quick-pin size-3 text-[var(--star)]" fill="currentColor" />}{clip.title || '未命名记录'}</strong>
              <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">{clip.type === 'image' ? '图片' : clip.type === 'file' ? fileSummary(clip.content, clip.fileSize) : clip.content.replace(/\n/g, ' ')}</span>
            </div>
            {selected?.id === clip.id && <Kbd className="shrink-0 bg-muted">↵ 复制</Kbd>}
          </button>
        ))}
      </div>

      <div className={cn('quick-footer flex h-9 shrink-0 items-center justify-between border-t border-border px-4 text-[11px] text-muted-foreground', quickOnly && 'mx-auto w-full max-w-[880px] border-t-0 px-6')}>
        <span className="quick-hints flex gap-4">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd>选择</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd>复制</span>
          <span className="flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>↵</Kbd>粘贴</span>
        </span>
        <span className="quick-status flex items-center gap-1.5"><StatusDot tone={nativeMode ? 'live' : 'demo'} />{nativeMode ? '本地剪贴板' : '浏览器演示'}</span>
      </div>
      <span className="sr-only">快捷呼出 {shortcut}</span>
    </div>
  )
}

export function QuickSwitcher({ open, quickOnly, dragging, active, collections, revision, copying, nativeMode, shortcut, notice, onCopy, onClose, portalContainer }: {
  open: boolean
  quickOnly: boolean
  dragging: boolean
  active: Clip[]
  collections: string[]
  revision: number
  copying: boolean
  nativeMode: boolean
  shortcut: string
  notice: string
  onCopy: (clip: Clip, close?: boolean, paste?: boolean) => void
  onClose: () => void
  portalContainer?: HTMLElement | null
}) {
  const panel = <QuickPanel active={active} collections={collections} copying={copying} dragging={dragging} nativeMode={nativeMode} notice={notice} onClose={onClose} onCopy={onCopy} quickOnly={quickOnly} revision={revision} shortcut={shortcut} />
  if(quickOnly) {
    return open
      ? <div aria-label="快捷窗口" className="quick-modal flex h-dvh w-full min-w-0 flex-col bg-background" role="dialog">{panel}</div>
      : null
  }
  return (
    <Dialog onOpenChange={next => { if(!next) onClose() }} open={open}>
      <DialogPopup
        aria-label="快捷窗口"
        bottomStickOnMobile={false}
        className="quick-modal w-[680px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-2xl p-0"
        portalProps={{ container: portalContainer ?? undefined }}
        showCloseButton={false}
      >
        {panel}
      </DialogPopup>
    </Dialog>
  )
}
