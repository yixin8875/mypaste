import { Clipboard, Folder, PanelLeftClose, Pause, Play, Plus, Settings, ShieldCheck, SlidersHorizontal, Star, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { typeNames } from '@/lib/format'
import type { Kind } from '@/clipboard-service'
import { IconButton, StatusDot, TypeIcon } from './shared'
import mypasteMark from '@/assets/mypaste-mark.svg'

export type SidebarCounts = { all: number; favorites: number; text: number; link: number; image: number; file: number }

function NavItem({ icon, label, count, selected, onClick }: { icon: React.ReactNode; label: string; count?: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        'group relative flex h-8 w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        selected && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-xs',
      )}
      onClick={onClick}
      type="button"
    >
      {selected && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary" />}
      <span className={cn('grid place-items-center text-muted-foreground [&_svg]:size-4', selected && 'text-primary')}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{count}</span>}
    </button>
  )
}

const SectionLabel = ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
  <div className="flex h-7 shrink-0 items-center justify-between px-2 pt-2 text-[11px] font-medium tracking-wide text-muted-foreground">
    <span>{children}</span>
    {actions && <span className="flex items-center gap-0.5">{actions}</span>}
  </div>
)

export function Sidebar({ nav, onNavigate, counts, collections, paused, captureState, nativeMode, ready, busy, sidebarOpen, onCloseSidebar, onTogglePaused, onSettings, onNewCollection, onManageCollections }: {
  nav: string
  onNavigate: (value: string) => void
  counts: SidebarCounts
  collections: string[]
  paused: boolean
  captureState?: 'running' | 'paused' | 'error'
  nativeMode: boolean
  ready: boolean
  busy: boolean
  sidebarOpen: boolean
  onCloseSidebar: () => void
  onTogglePaused: () => void
  onSettings: () => void
  onNewCollection: () => void
  onManageCollections: () => void
}) {
  const captureLabel = !ready ? '正在连接本地服务' : paused ? '记录已暂停' : captureState === 'error' ? '记录服务异常' : nativeMode ? '正在记录剪贴板' : '演示记录状态'
  const captureHint = nativeMode ? (captureState === 'error' ? '查看设置中的诊断信息' : paused ? '点击恢复记录' : '后台监听已连接') : '浏览器不监听剪贴板'
  return (
    <>
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/20 min-[951px]:hidden" onClick={onCloseSidebar} />}
      <aside
        aria-label="主导航"
        className={cn(
          'flex w-56 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar p-2.5 max-[1150px]:w-[220px] min-[1550px]:w-64 max-[950px]:fixed max-[950px]:inset-y-0 max-[950px]:left-0 max-[950px]:z-40 max-[950px]:w-60 max-[950px]:-translate-x-full max-[950px]:shadow-[8px_0_24px_rgba(31,27,22,.12)] max-[950px]:transition-transform max-[950px]:duration-200',
          sidebarOpen && 'max-[950px]:translate-x-0',
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 px-1">
          <div className="size-8 shrink-0 overflow-hidden rounded-lg"><img alt="" className="size-full" src={mypasteMark} /></div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold text-foreground">MyPaste</div>
            <div className="truncate text-[11px] text-muted-foreground">本地剪贴板历史</div>
          </div>
          <IconButton className="min-[951px]:hidden" label="收起侧栏" onClick={onCloseSidebar}><PanelLeftClose size={17} /></IconButton>
        </div>

        <nav className="mt-1 flex flex-col gap-1">
          <NavItem count={counts.all} icon={<Clipboard />} label="全部记录" onClick={() => onNavigate('全部记录')} selected={nav === '全部记录'} />
          <NavItem count={counts.favorites} icon={<Star />} label="收藏" onClick={() => onNavigate('收藏')} selected={nav === '收藏'} />
        </nav>

        <SectionLabel>内容类型</SectionLabel>
        <div className="flex flex-col gap-1">
          {(['text', 'link', 'image', 'file'] as Kind[]).map(type => (
            <NavItem count={counts[type]} icon={<TypeIcon type={type} size={16} />} key={type} label={typeNames[type]} onClick={() => onNavigate(type)} selected={nav === type} />
          ))}
        </div>

        <SectionLabel actions={<>
          <IconButton disabled={!ready} label="新建集合" onClick={onNewCollection}><Plus size={14} /></IconButton>
          <IconButton disabled={!ready || collections.length === 0} label="管理集合" onClick={onManageCollections}><SlidersHorizontal size={14} /></IconButton>
        </>}>我的集合</SectionLabel>
        <div className="flex flex-col gap-1">
          {collections.map(name => (
            <NavItem icon={<Folder />} key={name} label={name} onClick={() => onNavigate(name)} selected={nav === name} />
          ))}
        </div>

        <div className="mt-auto shrink-0 pt-4">
          <NavItem icon={<Trash2 />} label="最近删除" onClick={() => onNavigate('最近删除')} selected={nav === '最近删除'} />
          <div className="mx-2 my-2 h-px bg-sidebar-border" />
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent disabled:opacity-50"
            disabled={!ready || busy}
            onClick={onTogglePaused}
            type="button"
          >
            <StatusDot tone={paused || captureState === 'error' ? 'paused' : 'live'} />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[12px] text-sidebar-foreground">{captureLabel}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{captureHint}</span>
            </span>
            {paused ? <Play className="size-3.5 text-muted-foreground" /> : <Pause className="size-3.5 text-muted-foreground" />}
          </button>
          <NavItem icon={<Settings />} label="设置" onClick={onSettings} selected={false} />
          <div className="mt-1 flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground"><ShieldCheck size={13} />只保存在这台设备</div>
        </div>
      </aside>
    </>
  )
}
