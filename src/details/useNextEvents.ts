import { useEffect, useRef, useState } from 'react'
import type { DetailSnapshot, SnapshotPoint } from '../sim/snapshot'
import { NEXT_TARGETS, nextKey, requestFor, reproducible } from './nextEventModel'
import type { NextReply } from './nextEventModel'
import { failRunning, issue, needsQuery, receive } from './nextState'
import type { NextState } from './nextState'

/**
 * Next sunset / Earthset for the visible points at the page's selected time, computed in a background Worker from the
 * snapshot alone. Changing the selected time issues new requests; replies to older requests are dropped. Nothing here
 * touches the saved metrics. Not offered (and no Worker created) when the snapshot's model cannot be reproduced.
 */
export function useNextEvents(snap: DetailSnapshot, visible: SnapshotPoint[], selectedMs: number) {
  const [state, setState] = useState<NextState>({})
  const worker = useRef<Worker | null>(null)
  const seq = useRef(0)
  const repro = reproducible(snap)

  useEffect(() => () => { worker.current?.terminate(); worker.current = null }, [])

  const visibleKey = visible.map((p) => p.id).join(',')
  useEffect(() => {
    if (!repro.ok) return
    const wanted = visible.flatMap((p) => NEXT_TARGETS.map((t) => ({ p, t, key: nextKey(p.id, t) })))
    const missing = wanted.filter((w) => needsQuery(state, w.key, selectedMs))
    if (missing.length === 0) return
    if (!worker.current) {
      const w = new Worker(new URL('./nextWorker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (ev: MessageEvent<NextReply>) => {
        const m = ev.data
        setState((s) => receive(s, m.type === 'next-result' ? { requestId: m.requestId, result: m.result } : { requestId: m.requestId, message: m.message }))
      }
      w.onerror = (ev) => { worker.current?.terminate(); worker.current = null; setState((s) => failRunning(s, `The background query failed: ${ev.message || 'worker error'}`)) }
      worker.current = w
    }
    const issued = missing.map((m) => ({ ...m, requestId: `next-${++seq.current}` }))
    for (const m of issued) worker.current.postMessage(requestFor(snap, m.p, m.t, selectedMs, m.requestId))
    setState((s) => issued.reduce((acc, m) => issue(acc, m.key, m.requestId, selectedMs), s))
    // A later run (after the state changes) finds nothing missing for this selected time, so there is no loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMs, visibleKey, snap, repro.ok, state])

  return { state, repro }
}
