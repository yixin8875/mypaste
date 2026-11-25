import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export function ConfirmDialog({ open, title, description, detail, confirmLabel = '确定', tone = 'default', busy = false, portalContainer, onConfirm, onClose }: {
  open: boolean
  title: string
  description: ReactNode
  detail?: string | null
  confirmLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  portalContainer?: HTMLElement | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog onOpenChange={next => { if(!next) onClose() }} open={open}>
      <DialogPopup
        aria-label={title}
        bottomStickOnMobile={false}
        className="w-[440px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0"
        closeProps={{ 'aria-label': '关闭' }}
        portalProps={{ container: portalContainer ?? undefined }}
      >
        <div className="px-6 pb-2 pt-5">
          <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-2 text-[12px] leading-5">{description}</DialogDescription>
          {detail && <p className="data-path mt-2 break-all rounded-md border border-border bg-muted/50 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">{detail}</p>}
        </div>
        <div className="modal-actions flex justify-end gap-2 border-t border-border bg-muted/40 px-6 py-3">
          <Button onClick={onClose} size="sm" variant="ghost">取消</Button>
          <Button disabled={busy} onClick={onConfirm} size="sm" variant={tone === 'danger' ? 'destructive' : 'default'}>{confirmLabel}</Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}

export function NewCollectionDialog({ open, name, busy, portalContainer, onName, onCreate, onClose }: {
  open: boolean
  name: string
  busy: boolean
  portalContainer?: HTMLElement | null
  onName: (value: string) => void
  onCreate: () => void
  onClose: () => void
}) {
  return (
    <Dialog onOpenChange={next => { if(!next) onClose() }} open={open}>
      <DialogPopup
        aria-label="新建集合"
        bottomStickOnMobile={false}
        className="w-[420px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0"
        closeProps={{ 'aria-label': '关闭' }}
        portalProps={{ container: portalContainer ?? undefined }}
      >
        <form onSubmit={event => { event.preventDefault(); onCreate() }}>
          <div className="px-6 pb-3 pt-5">
            <DialogTitle className="text-[15px] font-semibold">新建集合</DialogTitle>
            <label className="field-label mt-4 block text-[12px] text-muted-foreground">
              集合名称
              <Input aria-label="集合名称" className="mt-1.5" maxLength={80} onChange={event => onName(event.target.value)} placeholder="例如：写作素材" value={name} />
            </label>
            <p className="form-help mt-2 text-[11px] leading-5 text-muted-foreground">把经常一起使用的内容放在一起。</p>
          </div>
          <div className="modal-actions flex justify-end gap-2 border-t border-border bg-muted/40 px-6 py-3">
            <Button onClick={onClose} size="sm" type="button" variant="ghost">取消</Button>
            <Button className="primary-button" disabled={busy || !name.trim()} size="sm" type="submit">创建集合</Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
