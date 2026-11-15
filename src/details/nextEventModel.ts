// Next sunset / Earthset on the details page (step 22): types, the "can this snapshot's model be reproduced" check, and
// the messages of the background Worker. Light module (no astronomy code), safe for the page's main bundle.
import { CURRENT_MODEL_VERSIONS } from '../sim/task'
import type { DetailSnapshot, SnapshotPoint } from '../sim/snapshot'
import type { NextSet } from '../sim/events'

export type NextTarget = 'sunset' | 'earthset'
export const NEXT_TARGETS: NextTarget[] = ['sunset', 'earthset']
/** Search length after the selected time (the nextSet default). */
export const NEXT_SEARCH_MS = 60 * 86_400_000

export type NextRequest = {
  requestId: string
  pointId: string
  target: NextTarget
  queryMs: number
  searchMs: number
  /** Everything the query needs comes from the snapshot: site with horizon and the Earth minimum elevation. */
  site: SnapshotPoint['data']['site']
  earthMinElevationDeg: number
  /** True when the point was assessed in the regional estimate: the same estimated visibility policy is used for the new query. */
  estimated: boolean
}
export type NextReply =
  | { type: 'next-result'; requestId: string; result: NextSet }
  | { type: 'next-error'; requestId: string; message: string }

export const nextKey = (pointId: string, target: NextTarget) => `${pointId}|${target}`

export type Reproducible = { ok: true } | { ok: false; reason: string }

/**
 * New queries run with the code of this page, so they are only offered when the snapshot was made by the same
 * visibility, event-search and ephemeris models. Otherwise they could silently differ from the saved numbers.
 */
export function reproducible(snap: DetailSnapshot): Reproducible {
  const cur = CURRENT_MODEL_VERSIONS.models, old = snap.versions.models
  // An estimated snapshot also depends on the regional model (nominal skyline policy); an evidence snapshot does not.
  const keys = snap.assessment.mode === 'relaxed' ? (['visibility', 'ephemeris', 'regional'] as const) : (['visibility', 'ephemeris'] as const)
  const diff = [keys.filter((k) => old[k] !== cur[k]).join(' and ')].filter(Boolean)[0]
  if (!diff) return { ok: true }
  return { ok: false, reason: `New next-sunset and next-Earthset queries are unavailable: this snapshot was made with a different ${diff} model than this page uses, so a new query could disagree with the saved numbers. The saved metrics above are unaffected.` }
}

export function requestFor(snap: DetailSnapshot, p: SnapshotPoint, target: NextTarget, queryMs: number, requestId: string): NextRequest {
  return { requestId, pointId: p.id, target, queryMs, searchMs: NEXT_SEARCH_MS, site: p.data.site, earthMinElevationDeg: (snap.settings as { earthMinElevationDeg: number }).earthMinElevationDeg, estimated: p.assessment.decision?.estimated ?? false }
}

/** How a NextSet result reads, without ever turning a missing event into 0. */
export function describeNext(r: NextSet, target: NextTarget): { state: NextSet['status']; headline: string; detail: string } {
  const name = target === 'sunset' ? 'sunset' : 'Earthset'
  const range = `searched ${new Date(r.searchStartMs).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(r.searchedToMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const reasons = r.reasons.map((x) => x.message).join('; ')
  switch (r.status) {
    case 'found': return { state: 'found', headline: `${new Date(r.eventMs!).toISOString().replace('T', ' ').slice(0, 19)} UTC (±${(r.toleranceMs! / 1000).toFixed(1)} s)`, detail: `${range}${reasons ? `; ${reasons}` : ''}` }
    case 'not-found': return { state: 'not-found', headline: `No ${name} in the searched range`, detail: `${range}. This is not zero time: it means no ${name} occurs within this range.` }
    case 'unknown': return { state: 'unknown', headline: `Unknown: the next ${name} cannot be determined`, detail: `${range}; ${reasons}` }
    default: return { state: 'incomplete', headline: `Incomplete: search did not cover the whole range`, detail: `${range}; ${reasons}` }
  }
}
