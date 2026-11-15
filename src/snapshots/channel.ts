// Best-effort message from the home page to a waiting details tab: "saving this snapshot failed" (so the tab can stop
// waiting and say why). Correctness never depends on it: without BroadcastChannel the tab simply times out into the
// "not found" state. No data travels here, only the ID and a short reason.
export const SNAPSHOT_CHANNEL = 'lunar-navigator.snapshots'
export type SnapshotNotice = { id: string; status: 'saved' | 'failed'; message?: string }

function open(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SNAPSHOT_CHANNEL)
}

export function announce(n: SnapshotNotice) {
  const ch = open()
  if (!ch) return
  try { ch.postMessage(n) } finally { ch.close() }
}

/** Listen for notices about one ID. Returns an unsubscribe function. */
export function listen(id: string, fn: (n: SnapshotNotice) => void): () => void {
  const ch = open()
  if (!ch) return () => undefined
  ch.onmessage = (ev: MessageEvent) => { const n = ev.data as SnapshotNotice; if (n && n.id === id) fn(n) }
  return () => ch.close()
}
