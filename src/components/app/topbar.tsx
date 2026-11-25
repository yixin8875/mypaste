import { Keyboard, Menu, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Kbd } from '@/components/ui/kbd'
import { IconButton } from './shared'

export function Topbar({ heading, nativeMode, shortcut, onOpenSidebar, onOpenQuick, onOpenSettings }: {
  heading: string
  nativeMode: boolean
  shortcut: string
  onOpenSidebar: () => void
  onOpenQuick: () => void
  onOpenSettings: () => void
}) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4 max-[1150px]:px-3">
      <IconButton className="-ml-1 min-[951px]:hidden" label="打开导航" onClick={onOpenSidebar}><Menu size={17} /></IconButton>
      <div className="min-w-0 truncate text-[12px] font-medium text-muted-foreground">{heading}</div>
      <div className="ml-auto flex items-center gap-2.5">
        <Badge className="prototype-badge max-[950px]:hidden" variant="outline">{nativeMode ? '本地模式' : '浏览器演示'}</Badge>
        <button
          className="quiet-button inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onOpenQuick}
          type="button"
        >
          <Keyboard className="size-4" />
          <span className="max-[680px]:hidden">快捷窗口</span>
          <Kbd className="max-[680px]:hidden">{shortcut}</Kbd>
        </button>
        <span className="h-4 w-px bg-border" />
        <IconButton label="设置" onClick={onOpenSettings}><SlidersHorizontal size={17} /></IconButton>
      </div>
    </header>
  )
}
