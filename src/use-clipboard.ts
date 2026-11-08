import { useCallback, useEffect, useRef, useState } from 'react'
import { clipboardService, errorMessage, type Clip, type Snapshot } from './clipboard-service'

export function useClipboard(onQuickOpen: () => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [writeError, setWriteError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(0)
  const [revision, setRevision] = useState(0)
  const live = useRef(false)
  const generation = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const openRef = useRef(onQuickOpen); openRef.current = onQuickOpen
  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      const next = await clipboardService.snapshot()
      if(live.current && request === generation.current) {
        setSnapshot(next); setError(''); setLoading(false); setRevision(value => value + 1)
      }
    } catch(cause) {
      if(live.current && request === generation.current) { setError(errorMessage(cause)); setLoading(false) }
    }
  }, [])
  useEffect(() => {
    live.current = true
    let disposed = false
    let unlisten: (() => void) | undefined
    void clipboardService.subscribe(() => { if(!disposed) void refresh() }, () => { if(!disposed) openRef.current() }).then(fn => {
      if(disposed) { fn(); return }
      unlisten = fn; void refresh()
    }).catch(cause => { if(!disposed) { setError(errorMessage(cause)); setLoading(false) } })
    return () => { disposed = true; live.current = false; generation.current++; unlisten?.() }
  }, [refresh])
  // Serialize writes so a slow earlier edit cannot overwrite a newer edit.
  const run = useCallback((action: () => Promise<void>): Promise<boolean> => {
    setPending(count => count + 1)
    const operation = queue.current.then(async () => {
      try { await action(); if(live.current) setWriteError(''); await refresh(); return true }
      catch(cause) { if(live.current) setWriteError(errorMessage(cause)); return false }
      finally { if(live.current) setPending(count => count - 1) }
    })
    queue.current = operation.catch(() => undefined)
    return operation
  }, [refresh])
  return { snapshot, loading, busy: pending > 0, error: writeError || error, revision, refresh, run, dismissError: () => { setError(''); setWriteError('') } }
}

export function useClipDetail(id: number | undefined, revision: number) {
  const [detail, setDetail] = useState<Clip | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    setDetail(null); setError('')
    if(id !== undefined) void clipboardService.item(id).then(value => { if(!disposed) setDetail(value) }).catch(cause => { if(!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true }
  }, [id, revision])
  return { detail: detail?.id === id ? detail : null, error }
}

export function useSearchIds(query: string, revision: number) {
  const [result, setResult] = useState<{ query: string; revision: number; ids: Set<number> } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    setError('')
    if(!query) { setResult(null); return }
    const timer = setTimeout(() => {
      void clipboardService.search(query).then(ids => { if(!disposed) setResult({ query, revision, ids: new Set(ids) }) }).catch(cause => { if(!disposed) setError(errorMessage(cause)) })
    }, 150)
    return () => { disposed = true; clearTimeout(timer) }
  }, [query, revision])
  const current = result?.query === query && result.revision === revision
  return { ids: query ? (current ? result.ids : new Set<number>()) : null, loading: !!query && !current && !error, error }
}
