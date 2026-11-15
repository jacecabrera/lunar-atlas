// Builds a detail snapshot (step 21) from the current task and custom sites. Called once, at the Learn more click.
// Pure: the caller passes the data (no store access), and the result is an independent deep copy, so nothing that happens
// to the stores afterwards (edits, recalculation, delete, Clear) can reach it.
import { loadCandidateCatalog, toCandidateRecord } from '../sim/catalog'
import { loadMissionDefaults } from '../sim/defaults'
import type { AdvancedSettings, MissionInput } from '../sim/mission'
import type { CandidateRecord, ConditionReason, SiteAssessment } from '../sim/assessment'
import type { TaskState } from '../sim/task'
import type { SourceRef } from '../sim/provenance'
import { SNAPSHOT_SCHEMA, SNAPSHOT_SCHEMA_VERSION, validateSnapshot } from '../sim/snapshot'
import type { DetailSnapshot, SnapshotExclusion, SnapshotPoint } from '../sim/snapshot'
import { isValidCustom } from '../state/customSitesModel'
import type { CustomSite } from '../state/customSitesModel'

export type BuildArgs = {
  task: TaskState
  input: MissionInput | null
  settings: AdvancedSettings
  customs: CustomSite[]
  maxCustom: number
  snapshotId: string
  nowMs: number
}
export type BuildResult = { ok: true; snapshot: DetailSnapshot } | { ok: false; reason: string }

/** Why the button cannot work, or null when a snapshot can be made. Same rule the button uses. */
export function snapshotBlockedReason(task: TaskState): string | null {
  if (task.status === 'done') return null
  if (task.status === 'stale') return 'The results are out of date; calculate again to open details'
  if (task.status === 'running') return 'The calculation is still running'
  if (task.status === 'error') return 'The calculation failed; there is nothing to show'
  return 'Calculate the mission first'
}

const distinctBy = <T>(items: T[], key: (x: T) => string) => { const m = new Map<string, T>(); for (const x of items) if (!m.has(key(x))) m.set(key(x), x); return [...m.values()] }

function pointSources(candidate: CandidateRecord, a: SiteAssessment): { sources: SourceRef[]; limits: string[] } {
  const sources: SourceRef[] = candidate.source ? [candidate.source] : []
  const limits: string[] = []
  for (const c of Object.values(a.conditions)) { sources.push(...(c.sources ?? [])); limits.push(...(c.limitations ?? [])) }
  return { sources, limits }
}

export function buildSnapshot(a: BuildArgs): BuildResult {
  const { task } = a
  const blocked = snapshotBlockedReason(task)
  if (blocked || task.status !== 'done') return { ok: false, reason: blocked ?? 'No completed task' }
  if (!a.input) return { ok: false, reason: 'The mission inputs of this result are not available' }
  const r = task.result
  const catalog = loadCandidateCatalog()
  const points: SnapshotPoint[] = []

  for (const rec of r.recommendations) {
    const c = catalog.candidates.find((x) => x.id === rec.siteId)
    const assessment = r.sites.find((s) => s.siteId === rec.siteId)
    const data = r.pointData?.[rec.siteId]
    if (!c || !assessment) return { ok: false, reason: `The result for ${rec.siteId} is incomplete` }
    if (!data) return { ok: false, reason: `Detail data for ${c.name} is not available in this result; calculate again` }
    points.push({
      id: rec.siteId, name: c.name, kind: 'recommendation', rank: rec.rank, score: rec.score, lat: c.coordinate.lat, lon: c.coordinate.lon,
      candidate: toCandidateRecord(c, catalog), assessment, transit: r.transits?.[rec.siteId] ?? null, data,
    })
  }
  // Whole-Moon search results (relaxed mode): valid points like the others, labelled as search results.
  for (const x of r.search?.results ?? []) {
    const data = r.pointData?.[x.siteId]
    if (!data) return { ok: false, reason: `Detail data for ${x.name} is not available in this result; calculate again` }
    points.push({
      id: x.siteId, name: x.name, kind: 'search', rank: x.rank, score: x.score, lat: x.lat, lon: x.lon,
      candidate: { id: x.siteId, name: x.name, origin: 'search', lat: x.lat, lon: x.lon, frame: 'global grid point (DE421 mean Earth)' },
      assessment: x.assessment, transit: x.transit, data,
    })
  }
  for (const s of a.customs) {
    if (!isValidCustom(s, task, a.customs.length, a.maxCustom)) continue // drafts, invalid and failed sites are not in a snapshot
    if (s.evaluation.state !== 'assessed') continue
    const name = s.name || s.id
    if (!s.evaluation.pointData) return { ok: false, reason: `Detail data for ${name} is not available; check the site again` }
    points.push({
      id: s.id, name, kind: 'custom', rank: null, score: null, lat: s.lat!, lon: s.lon!,
      candidate: { id: s.id, name, origin: 'custom', lat: s.lat!, lon: s.lon!, frame: 'user input (used as DE421 mean Earth)' },
      assessment: s.evaluation.assessment, transit: s.evaluation.transit ?? null, data: s.evaluation.pointData,
    })
  }

  const nameOf = (id: string) => catalog.candidates.find((c) => c.id === id)?.name ?? id
  const ex = r.evaluation?.excluded
  const exclusions: SnapshotExclusion[] = []
  const add = (group: SnapshotExclusion['group'], list: Array<{ siteId: string; reasons: ConditionReason[] }>) => { for (const x of list) exclusions.push({ siteId: x.siteId, name: nameOf(x.siteId), group, reasons: x.reasons.map(({ code, message }) => ({ code, message })) }) }
  if (ex) {
    add('physical-fail', ex.physicalFail); add('insufficient-data', ex.insufficientData); add('service-error', ex.serviceError)
    add('not-scored', ex.notScored.map((x) => ({ siteId: x.siteId, reasons: [x.reason] })))
    add('beyond-limit', ex.beyondLimit.map((id) => ({ siteId: id, reasons: [{ code: 'beyond-recommendation-limit', message: 'Eligible, but ranked below the maximum number of recommendations' }] })))
  }

  const gathered = points.map((p) => pointSources(p.candidate, p.assessment))
  const defaults = loadMissionDefaults()
  const draft: DetailSnapshot = {
    schema: SNAPSHOT_SCHEMA, schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshotId: a.snapshotId, createdAtMs: a.nowMs,
    task: { requestId: r.requestId, fingerprint: r.fingerprint, completedAtMs: r.completedAtMs, runtime: r.runtime ?? null, recommendationModel: r.evaluation?.model ?? null },
    versions: r.versions, input: a.input, settings: a.settings,
    assessment: { mode: r.mode ?? 'strict', legacy: false, search: r.search ? (({ results, ...rest }) => { void results; return rest })(r.search) : null },
    preset: { presetId: defaults.presetId, dataVersion: defaults.dataVersion, label: defaults.label, parameters: defaults.parameters },
    points, exclusions,
    sources: distinctBy(gathered.flatMap((g) => g.sources), (s) => s.id),
    limits: [...new Set(gathered.flatMap((g) => g.limits))],
  }
  // Independent deep copy, then the same validation a loaded snapshot goes through.
  let copy: unknown
  try { copy = structuredClone(draft) } catch (e) { return { ok: false, reason: `The snapshot data could not be copied: ${e instanceof Error ? e.message : String(e)}` } }
  const check = validateSnapshot(copy)
  return check.ok ? { ok: true, snapshot: check.snapshot } : { ok: false, reason: check.error }
}
