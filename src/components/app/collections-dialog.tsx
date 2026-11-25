import { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Folder } from 'lucide-react'
import type { Clip, CollectionPolicy } from '@/clipboard-service'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { IconButton } from './shared'

const policyTextFor = (policy: CollectionPolicy) => {
  if(policy.retentionDays === null && policy.maxItems === null) return '跟随全局'
  const retention = policy.retentionDays === null ? '跟随全局' : policy.retentionDays === 365 ? '1 年' : `${policy.retentionDays} 天`
  const limit = policy.maxItems === null ? '跟随全局' : `${policy.maxItems.toLocaleString('zh-CN')} 条`
  return `保留 ${retention} · 上限 ${limit}`
}

const smallSelect = 'h-7 appearance-none rounded-md border border-input bg-card pl-2 pr-6 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50'

export function CollectionsDialog({ open, onClose, collections, active, policies, busy, portalContainer, onRename, onDelete, onMove, onPolicy }: {
  open: boolean
  onClose: () => void
  collections: string[]
  active: Clip[]
  policies: CollectionPolicy[]
  busy: boolean
  portalContainer?: HTMLElement | null
  onRename: (from: string, to: string) => Promise<boolean>
  onDelete: (name: string) => Promise<boolean>
  onMove: (name: string, direction: 'up' | 'down') => void
  onPolicy: (name: string, retentionDays: number | null, maxItems: number | null) => void
}) {
  const [renameTarget, setRenameTarget] = useState(''), [renameDraft, setRenameDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(''), [policyEdit, setPolicyEdit] = useState('')
  const policyFor = (name: string): CollectionPolicy => policies.find(policy => policy.name === name) ?? { name, retentionDays: null, maxItems: null }

  const reset = () => { setRenameTarget(''); setDeleteTarget(''); setPolicyEdit('') }
  const close = () => { reset(); onClose() }
  const startRename = (name: string) => { setRenameTarget(name); setRenameDraft(name); setPolicyEdit('') }

  return (
    <Dialog onOpenChange={next => { if(!next) close() }} open={open}>
      <DialogPopup
        aria-label="管理集合"
        bottomStickOnMobile={false}
        className="collection-modal flex max-h-[min(720px,calc(100dvh-3rem))] w-[560px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0"
        closeProps={{ 'aria-label': '关闭' }}
        portalProps={{ container: portalContainer ?? undefined }}
      >
        <DialogTitle className="px-6 pb-2 pt-5 text-[16px] font-semibold tracking-tight">管理集合</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-2 pt-2">
          {collections.length === 0
            ? <p className="empty-inline py-6 text-center text-[12px] text-muted-foreground">还没有集合。先新建一个，再把常用内容放进去。</p>
            : <div className="collection-list flex flex-col">
              {collections.map((name, index) => {
                const policy = policyFor(name)
                const summary = policyTextFor(policy)
                return (
                  <div className="collection-row flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-0" key={name}>
                    {renameTarget === name
                      ? <form className="collection-rename flex flex-1 items-center gap-2" onSubmit={event => { event.preventDefault(); void onRename(name, renameDraft.trim()).then(ok => { if(ok) setRenameTarget('') }) }}>
                        <input aria-label={`重命名 ${name}`} className="h-7 flex-1 rounded-md border border-input bg-card px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40" maxLength={80} onChange={event => setRenameDraft(event.target.value)} value={renameDraft} />
                        <Button disabled={busy || !renameDraft.trim()} size="sm" type="submit" variant="outline">保存</Button>
                        <Button onClick={() => setRenameTarget('')} size="sm" type="button" variant="ghost">取消</Button>
                      </form>
                      : deleteTarget === name
                        ? <div className="collection-confirm flex flex-1 flex-wrap items-center gap-3" role="alert">
                          <span className="min-w-[140px] flex-1 text-[12px] text-[var(--destructive-foreground)]">删除「{name}」？其中的记录会保留。</span>
                          <div className="flex gap-1">
                            <Button onClick={() => setDeleteTarget('')} size="xs" variant="ghost">取消</Button>
                            <Button className="text-[var(--destructive-foreground)]" disabled={busy} onClick={() => void onDelete(name).then(ok => { if(ok) setDeleteTarget('') })} size="xs" variant="ghost">删除集合</Button>
                          </div>
                        </div>
                        : <>
                          <span className="collection-name flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground"><Folder className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{name}</span><small className="shrink-0 font-mono text-[11px] text-muted-foreground">{active.filter(clip => clip.collections.includes(name)).length} 条</small></span>
                          <button
                            aria-controls={`policy-${index}`}
                            aria-expanded={policyEdit === name}
                            className={cn('policy-summary inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', summary !== '跟随全局' && 'custom text-primary', policyEdit === name && 'open')}
                            onClick={() => setPolicyEdit(policyEdit === name ? '' : name)}
                            title="设置保留策略"
                            type="button"
                          >
                            {summary}<ChevronDown className={cn('size-3 transition-transform', policyEdit === name && 'rotate-180')} />
                          </button>
                          <div className="collection-actions flex items-center gap-0.5">
                            <IconButton disabled={busy || index === 0} label={`上移 ${name}`} onClick={() => onMove(name, 'up')}><ArrowUp size={13} /></IconButton>
                            <IconButton disabled={busy || index === collections.length - 1} label={`下移 ${name}`} onClick={() => onMove(name, 'down')}><ArrowDown size={13} /></IconButton>
                            <Button disabled={busy} onClick={() => startRename(name)} size="xs" variant="ghost">重命名</Button>
                            <Button className="text-[var(--destructive-foreground)]" disabled={busy} onClick={() => setDeleteTarget(name)} size="xs" variant="ghost">删除</Button>
                          </div>
                          {policyEdit === name && <div className="collection-policy flex w-full flex-wrap items-center gap-3 pb-1 pl-5 pt-1" id={`policy-${index}`}>
                            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">保留
                              <span className="relative inline-flex items-center">
                                <select aria-label={`${name} 保留时间`} className={smallSelect} disabled={busy} onChange={event => onPolicy(name, event.target.value === '' ? null : Number(event.target.value), policy.maxItems)} value={policy.retentionDays ?? ''}>
                                  <option value="">跟随全局</option><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>1 年</option>
                                </select>
                                <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-muted-foreground" />
                              </span>
                            </label>
                            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">上限
                              <span className="relative inline-flex items-center">
                                <select aria-label={`${name} 条数上限`} className={smallSelect} disabled={busy} onChange={event => onPolicy(name, policy.retentionDays, event.target.value === '' ? null : Number(event.target.value))} value={policy.maxItems ?? ''}>
                                  <option value="">跟随全局</option><option value={100}>100 条</option><option value={500}>500 条</option><option value={1000}>1,000 条</option><option value={5000}>5,000 条</option>
                                </select>
                                <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-muted-foreground" />
                              </span>
                            </label>
                            <Button className="ml-auto" onClick={() => setPolicyEdit('')} size="xs" variant="ghost">收起</Button>
                          </div>}
                        </>}
                  </div>
                )
              })}
            </div>}
          <p className="form-help mt-3 text-[11px] leading-5 text-muted-foreground">删除集合不会删除其中的记录。排序会同步到侧栏。集合的保留时间与条数上限只作用于该集合；收藏与置顶始终保留。</p>
        </div>
        <div className="modal-actions flex shrink-0 items-center justify-end border-t border-border bg-muted/40 px-6 py-3">
          <Button className="primary-button" onClick={close}>完成</Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
