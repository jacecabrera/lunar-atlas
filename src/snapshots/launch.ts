// "Learn more" (step 21): open the details tab at click time, then build and save the snapshot once.
//
// Popup policy: window.open must run synchronously inside the click, so the tab is opened first, pointing at the details
// page with only the snapshot ID in the URL; that page waits for the snapshot (waitForSnapshot) while this code builds and
// saves it. If the browser blocks the tab the snapshot is still saved and the caller gets the URL for a link the user can
// click. opener is cleared so the details page never depends on this window. A failure is announced to the waiting tab and
// returned for the home page to show, with Retry creating a fresh snapshot.
import { newSnapshotId } from '../sim/snapshot'
import type { DetailSnapshot } from '../sim/snapshot'
import { buildSnapshot } from './build'
import type { BuildArgs } from './build'
import { saveSnapshot } from './storage'
import type { SnapshotBackend } from './storage'
import { announce } from './channel'

export type LaunchDeps = {
  open: (url: string) => { opener: unknown } | null
  backend: SnapshotBackend
  args: () => Omit<BuildArgs, 'snapshotId' | 'nowMs'>
  detailsUrl: (id: string) => string
  now?: () => number
  newId?: () => string
}

export type LaunchOutcome =
  | { ok: true; id: string; url: string; opened: boolean }
  | { ok: false; id: string; url: string; opened: boolean; error: string }

/** The details page URL for a snapshot ID, for the deployed base path (root or /moon-planner/). */
export function detailsUrl(id: string, base = import.meta.env.BASE_URL, href = typeof location === 'undefined' ? 'http://localhost/' : location.href): string {
  return new URL(`${base}details.html?snapshot=${encodeURIComponent(id)}`, href).href
}

/** Must be called directly from the click handler (the tab is opened before the first await). */
export function launchDetails(d: LaunchDeps): Promise<LaunchOutcome> {
  const id = (d.newId ?? newSnapshotId)()
  const url = d.detailsUrl(id)
  const win = (() => { try { return d.open(url) } catch { return null } })()
  if (win) { try { win.opener = null } catch { /* cross-origin or already closed: nothing to do */ } }
  const opened = win !== null
  const fail = (error: string): LaunchOutcome => { announce({ id, status: 'failed', message: error }); return { ok: false, id, url, opened, error } }
  let snapshot: DetailSnapshot
  try {
    const built = buildSnapshot({ ...d.args(), snapshotId: id, nowMs: (d.now ?? Date.now)() })
    if (!built.ok) return Promise.resolve(fail(built.reason))
    snapshot = built.snapshot
  } catch (e) { return Promise.resolve(fail(e instanceof Error ? e.message : String(e))) }
  return saveSnapshot(d.backend, snapshot).then(
    () => { announce({ id, status: 'saved' }); return { ok: true, id, url, opened } as LaunchOutcome },
    (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
  )
}
