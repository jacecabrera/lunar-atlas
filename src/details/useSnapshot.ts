import { useCallback, useEffect, useState } from 'react'
import { indexedDbBackend, waitForSnapshot } from '../snapshots/storage'
import type { LoadResult } from '../snapshots/storage'
import { listen } from '../snapshots/channel'
import type { SnapshotBackend } from '../snapshots/storage'

export type SnapshotView = { phase: 'loading'; waitedMs: number } | { phase: 'result'; result: LoadResult; saveFailure?: string }

/** The snapshot ID from the page URL (?snapshot=...), the only thing the URL carries. */
export const snapshotIdFromLocation = (search = typeof location === 'undefined' ? '' : location.search) => new URLSearchParams(search).get('snapshot')

/**
 * Loads the snapshot named in the URL. While it is missing (the home page may still be saving) the hook keeps polling for
 * a bounded time and then settles on "missing"; retry() starts a new wait. Settles early when the opener reports a failure.
 */
/** Module-level so the default is the same function on every render (a new one per render would restart the effect and the wait). */
const defaultBackend = (): SnapshotBackend => indexedDbBackend()

export function useSnapshot(backendFactory: () => SnapshotBackend = defaultBackend, id: string | null = snapshotIdFromLocation()) {
  const [view, setView] = useState<SnapshotView>({ phase: 'loading', waitedMs: 0 })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    let failure: string | null = null
    const off = id ? listen(id, (n) => { if (n.status === 'failed') failure = n.message ?? 'The main page could not save the details' }) : () => undefined
    const started = Date.now()
    const tick = window.setInterval(() => { if (!cancelled) setView((v) => (v.phase === 'loading' ? { phase: 'loading', waitedMs: Date.now() - started } : v)) }, 500)
    waitForSnapshot(backendFactory(), id, { isCancelled: () => cancelled, failed: () => failure }).then((r) => {
      if (!cancelled) setView({ phase: 'result', result: r, saveFailure: r.saveFailure })
    })
    return () => { cancelled = true; off(); window.clearInterval(tick) }
  }, [attempt, id, backendFactory])
  const retry = useCallback(() => { setView({ phase: 'loading', waitedMs: 0 }); setAttempt((a) => a + 1) }, [])
  return { view, retry }
}
