import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { FileText, FolderOpen, Image, Link2 } from 'lucide-react'
import { clipboardService as service, errorMessage, native, type Clip, type Kind } from '@/clipboard-service'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

export type { ReactNode }

export function TypeIcon({ type, size = 18 }: { type: Kind; size?: number }) {
  const Icon = type === 'link' ? Link2 : type === 'image' ? Image : type === 'file' ? FolderOpen : FileText
  return <Icon size={size} />
}

export function IconButton({ label, children, onClick, active = false, disabled = false, className }: { label: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn('shrink-0 text-muted-foreground hover:text-foreground', active && 'text-[var(--star)] hover:text-[var(--star)]', className)}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            title={label}
            type="button"
            variant="ghost"
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  )
}

export function StatusDot({ tone }: { tone: 'live' | 'paused' | 'demo' }) {
  return <span className={cn('size-2 shrink-0 rounded-full', tone === 'live' && 'bg-[var(--success)]', tone === 'paused' && 'bg-[var(--warning)]', tone === 'demo' && 'bg-[var(--warning)]')} />
}

/** A lazy thumbnail for list and quick rows; loads when the row approaches the viewport. */
export function Thumb({ clip }: { clip: Clip }) {
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
  return (
    <div ref={ref} className="clip-thumb flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted text-muted-foreground">
      {url ? <img alt="" className="size-full object-cover" src={url}/> : failed ? <Image size={18}/> : <span className="block size-2 rounded-full bg-[var(--paper-line-strong)]"/>}
    </div>
  )
}

export function Picture({ clip }: { clip: Clip }) {
  const [data, setData] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false; setData(''); setError('')
    if(native) void service.image(clip.id).then(url => { if(!cancelled) setData(url) }).catch(cause => { if(!cancelled) setError(errorMessage(cause)) })
    return () => { cancelled = true }
  }, [clip.id])
  if(native) return <div className="native-image-preview paper-sheet grid min-h-24 place-items-center overflow-hidden">{error ? <p className="p-6 text-[13px] text-muted-foreground" role="alert">{error}</p> : data ? <img alt={clip.title} className="max-h-[420px] max-w-full object-contain" src={data}/> : <p className="p-6 text-[13px] text-muted-foreground">正在读取图片…</p>}</div>
  return (
    <div aria-label="示例图片：蓝色山峰与浅色天空" className="picture-preview paper-sheet relative h-[300px] overflow-hidden bg-gradient-to-b from-[#dde7f1] via-[#eef0ee] to-[#f6f0e4]" role="img">
      <div className="absolute right-[18%] top-[16%] size-16 rounded-full bg-[#f2c98a] shadow-[0_0_40px_12px_rgba(242,201,138,.35)]"/>
      <div className="absolute -inset-x-10 bottom-0 h-[62%] bg-[#a8bccd] [clip-path:polygon(0_100%,18%_46%,32%_66%,48%_24%,66%_58%,82%_38%,100%_100%)]"/>
      <div className="absolute -inset-x-10 bottom-0 h-[46%] bg-[#6f8da7] [clip-path:polygon(0_100%,14%_52%,30%_72%,52%_40%,70%_68%,88%_50%,100%_100%)]"/>
      <div className="absolute bottom-6 left-6 text-[22px] font-semibold tracking-tight text-white drop-shadow-sm">清晨的山脊<span className="mt-1 block font-mono text-[11px] font-normal opacity-80">PNG · 1920 × 1080</span></div>
    </div>
  )
}

type Draft = { value: string; version: number; failed: boolean }
export type DraftStore = Map<string, Draft>

export function Editable({ label, value, multiline = false, maxLength, disabled, save, cache, cacheKey = '', className }: { label: string; value: string; multiline?: boolean; maxLength: number; disabled: boolean; save: (value: string) => Promise<boolean>; cache?: DraftStore; cacheKey?: string; className?: string }) {
  const cached = cache?.get(cacheKey)
  const [draft, setDraft] = useState(cached?.value ?? value), [dirty, setDirty] = useState(!!cached), [failed, setFailed] = useState(cached?.failed ?? false)
  const focused = useRef(false), version = useRef(cached?.version ?? 0), mounted = useRef(true)
  const latest = useRef(value); latest.current = value
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if(!focused.current && !dirty) setDraft(value) }, [value, dirty])
  const props = {
    'aria-label': label, 'aria-invalid': failed, title: failed ? '尚未保存，失焦后重试；草稿已保留' : undefined,
    value: draft, disabled, maxLength, onFocus: () => { focused.current = true },
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
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
  const quiet = 'border-transparent bg-transparent shadow-none before:shadow-none hover:border-input hover:bg-card has-focus-visible:bg-card'
  return multiline
    ? <Textarea {...props} className={cn('w-full [&_textarea]:min-h-[116px] [&_textarea]:text-[13px] [&_textarea]:leading-6', quiet, className)} placeholder="添加备注"/>
    : <Input {...props} className={cn('h-8 border-transparent bg-transparent shadow-none before:shadow-none hover:border-input hover:bg-card has-focus-visible:bg-card sm:h-8 [&_input]:text-[13px]', quiet, className)} size="sm"/>
}
