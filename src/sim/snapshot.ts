// Detail snapshot (steps 03, 21): the read-only copy of one completed task that a Learn more tab displays.
//
// Schema version 3 (regional estimate revision; version 2 is read as a legacy strict snapshot, version 1 was a placeholder that nothing wrote). A snapshot is built once, at the click, from
// the valid points only: the recommendations of the task and the confirmed custom sites that are still valid. It holds
// everything the detail page (step 22) needs without the store, the task cache or the terrain files: inputs and settings,
// per point the assessment (conditions, metrics), the full mission statistics with the Sun elevation series, the transit
// estimate, and the site with its horizon (so new next-sunset / next-Earthset queries can be run from the snapshot alone).
// Everything is plain JSON-safe data: no functions, no class instances, no NaN or Infinity (a non-finite number would be
// silently turned into null by JSON, so it is rejected instead).
import type { MissionInput, AdvancedSettings } from './mission'
import type { CandidateRecord, ConditionReason, SiteAssessment } from './assessment'
import type { ModelVersions, PointData, TaskResult } from './task'
import type { TransitEstimate } from './transit'
import type { SourceRef } from './provenance'
import type { DefaultParameter } from './defaults'
import type { AssessmentModeName } from './assessment'
import type { SearchReport } from './task'

export const SNAPSHOT_SCHEMA = 'lunar-navigator.detail-snapshot'
export const SNAPSHOT_SCHEMA_VERSION = 3
/** Most points a snapshot can hold: maxRecommendations + maxCustomSites of the preset (3 + 9). Checked on save and load. */
export const SNAPSHOT_MAX_POINTS = 12

export type SnapshotPointKind = 'recommendation' | 'custom' | 'search'

export type SnapshotPoint = {
  /** Stable site ID (catalogue ID or custom-N). */
  id: string
  name: string
  kind: SnapshotPointKind
  /** Recommendation rank (1..3) and score (a ranking aid); null for custom sites. */
  rank: number | null
  score: number | null
  lat: number
  lon: number
  candidate: CandidateRecord
  assessment: SiteAssessment
  /** Transit estimate of the task (recommendations) or of the point itself (custom); null when none was computed. */
  transit: TransitEstimate | null
  /** Full statistics and the site with its horizon. */
  data: PointData
}

export type SnapshotExclusionGroup = 'physical-fail' | 'insufficient-data' | 'service-error' | 'not-scored' | 'beyond-limit'

/** Why a catalogue site is not among the points. Kept so an empty snapshot can say why. */
export type SnapshotExclusion = { siteId: string; name: string; group: SnapshotExclusionGroup; reasons: ConditionReason[] }

export type DetailSnapshot = {
  schema: typeof SNAPSHOT_SCHEMA
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  /** Unique per snapshot (not a timestamp alone). */
  snapshotId: string
  createdAtMs: number
  /** The task this snapshot copies. */
  task: { requestId: string; fingerprint: string; completedAtMs: number; runtime: TaskResult['runtime'] | null; recommendationModel: string | null }
  /** Data, model and contract versions of that task. */
  versions: ModelVersions
  input: MissionInput
  settings: AdvancedSettings
  /** Identity of the settings preset and its parameter table (units, provenance), as bundled when the snapshot was made. */
  preset: { presetId: string; dataVersion: string; label: string; parameters: Record<string, DefaultParameter> } | null
  /**
   * The assessment mode the task ran under, frozen with the snapshot. `legacy`: a version 2 snapshot, made before modes existed;
   * it is read under the evidence rules and never presented as an estimate. `search`: the whole-Moon search report (coverage, status) when one ran.
   */
  assessment: { mode: AssessmentModeName; legacy: boolean; search: Omit<SearchReport, 'results'> | null }
  /** Valid points only: recommendations in ranked order, search results, then confirmed custom sites in list order. May be empty. */
  points: SnapshotPoint[]
  exclusions: SnapshotExclusion[]
  /** Distinct sources named by the points. */
  sources: SourceRef[]
  /** Distinct model and data limits named by the points' conditions. */
  limits: string[]
}

// ─── Identity ──────────────────────────────────────────────────────────────

/** A unique snapshot ID. crypto.getRandomValues works on plain-http origins (randomUUID does not), with a weaker fallback. */
export function newSnapshotId(nowMs = Date.now()): string {
  const bytes = new Uint8Array(12)
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return `snap-${nowMs.toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** What a snapshot ID looks like (the only thing the details URL carries). */
export const SNAPSHOT_ID_PATTERN = /^snap-[0-9a-z]+-[0-9a-f]{24}$/

// ─── Validation ────────────────────────────────────────────────────────────

/** Path of the first NaN, Infinity, function, symbol, bigint, undefined-in-array or non-plain object, or null. */
export function findNonPlain(value: unknown, path = '$', depth = 0): string | null {
  if (depth > 64) return `${path} (too deep)`
  switch (typeof value) {
    case 'number': return Number.isFinite(value) ? null : `${path} (${String(value)})`
    case 'string': case 'boolean': return null
    case 'undefined': return null // an absent optional field; JSON drops it
    case 'object': {
      if (value === null) return null
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (value[i] === undefined) return `${path}[${i}] (undefined)`
          const r = findNonPlain(value[i], `${path}[${i}]`, depth + 1)
          if (r) return r
        }
        return null
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return `${path} (not a plain object)`
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const r = findNonPlain(v, `${path}.${k}`, depth + 1)
        if (r) return r
      }
      return null
    }
    default: return `${path} (${typeof value})`
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export type SnapshotCheck = { ok: true; snapshot: DetailSnapshot } | { ok: false; error: string; kind: 'corrupt' | 'unsupported-version' }

/**
 * Structural check of a snapshot object: envelope, identity, inputs, and for every point the fields the detail page reads.
 * Not a proof of the numbers, only that the data have the shape the page relies on and are plain and finite.
 */
export function validateSnapshot(input: unknown): SnapshotCheck {
  const bad = (error: string): SnapshotCheck => ({ ok: false, error, kind: 'corrupt' })
  if (!isObj(input)) return bad('Snapshot must be an object')
  // Version 2 (before assessment modes): kept readable as a legacy strict snapshot. Nothing is rewritten in storage; the copy is
  // only given the block that says so, and its decisions stay the evidence verdicts it was made with.
  const raw: Record<string, unknown> = input.schema === SNAPSHOT_SCHEMA && input.schemaVersion === 2 && !('assessment' in input)
    ? { ...input, schemaVersion: SNAPSHOT_SCHEMA_VERSION, assessment: { mode: 'strict', legacy: true, search: null } }
    : input
  if (raw.schema !== SNAPSHOT_SCHEMA) return bad('Not a detail snapshot')
  if (raw.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return { ok: false, kind: 'unsupported-version', error: `Unsupported snapshot version ${String(raw.schemaVersion)} (this page reads version ${SNAPSHOT_SCHEMA_VERSION})` }
  const plain = findNonPlain(raw)
  if (plain) return bad(`Snapshot contains a value that cannot be stored faithfully: ${plain}`)
  if (!isStr(raw.snapshotId) || !SNAPSHOT_ID_PATTERN.test(raw.snapshotId)) return bad('Snapshot field snapshotId is missing or malformed')
  if (!isNum(raw.createdAtMs)) return bad('Snapshot field createdAtMs is missing')
  const t = raw.task
  if (!isObj(t) || !isStr(t.requestId) || !isStr(t.fingerprint) || !isNum(t.completedAtMs)) return bad('Snapshot field task (original task identity) is missing')
  const v = raw.versions
  if (!isObj(v) || !isNum(v.contract) || !isObj(v.models) || !isObj(v.data)) return bad('Snapshot field versions is missing')
  const inp = raw.input
  if (!isObj(inp) || !isNum(inp.landingTimeMs) || !isNum(inp.durationMs) || !(inp.durationMs > 0) || !isObj(inp.launchSite) || !isNum(inp.launchSite.lat) || !isNum(inp.launchSite.lon)) return bad('Snapshot field input is missing or invalid')
  if (!isObj(raw.settings)) return bad('Snapshot field settings is missing')
  const am = raw.assessment
  if (!isObj(am) || (am.mode !== 'strict' && am.mode !== 'relaxed') || typeof am.legacy !== 'boolean' || (am.search !== null && !isObj(am.search))) return bad('Snapshot field assessment (mode) is missing or invalid')
  for (const key of ['points', 'exclusions', 'sources', 'limits'] as const) if (!Array.isArray(raw[key])) return bad(`Snapshot field ${key} must be a list`)
  const points = raw.points as unknown[]
  if (points.length > SNAPSHOT_MAX_POINTS) return bad(`Snapshot holds ${points.length} points; at most ${SNAPSHOT_MAX_POINTS} are allowed`)
  const seen = new Set<string>()
  for (const [i, p] of points.entries()) {
    const at = `points[${i}]`
    if (!isObj(p)) return bad(`${at} must be an object`)
    if (!isStr(p.id) || !isStr(p.name)) return bad(`${at} needs an id and a name`)
    if (seen.has(p.id)) return bad(`${at} repeats the id ${p.id}`)
    seen.add(p.id)
    if (p.kind !== 'recommendation' && p.kind !== 'custom' && p.kind !== 'search') return bad(`${at}.kind is invalid`)
    if (!isNum(p.lat) || p.lat < -90 || p.lat > 90 || !isNum(p.lon) || p.lon < -180 || p.lon > 180) return bad(`${at} has an invalid coordinate`)
    if (!isObj(p.candidate) || !isObj(p.assessment) || !isObj(p.assessment.summary) || !isObj(p.assessment.conditions)) return bad(`${at} needs candidate and assessment`)
    const dec = (p.assessment as Record<string, unknown>).decision
    const eligible = isObj(dec) ? dec.eligible : (p.assessment.summary as Record<string, unknown>).eligibleForRecommendation
    if (eligible !== true) return bad(`${at} is not a valid (qualifying) point`)
    if (isObj(dec) && (dec.mode !== am.mode)) return bad(`${at} was assessed under another mode than the snapshot`)
    const d = p.data
    if (!isObj(d) || !isObj(d.statistics) || !isObj(d.site)) return bad(`${at}.data needs statistics and site`)
    const s = d.statistics
    if (!isObj(s.window) || !isNum(s.window.startMs) || !isNum(s.window.endMs) || !(s.window.endMs > s.window.startMs)) return bad(`${at} statistics window is invalid`)
    if (!Array.isArray(s.sunSeries) || !Array.isArray(s.earthIntervals) || !Array.isArray(s.sunIntervals)) return bad(`${at} statistics are incomplete`)
    if (!isNum(d.site.lat) || !isNum(d.site.lon)) return bad(`${at}.data.site needs a coordinate`)
    if (p.transit !== null && !isObj(p.transit)) return bad(`${at}.transit must be an object or null`)
  }
  return { ok: true, snapshot: raw as unknown as DetailSnapshot }
}

/** JSON text of a validated snapshot. Throws when the snapshot is not valid (a bad snapshot is never written). */
export function serializeSnapshot(s: DetailSnapshot): string {
  const r = validateSnapshot(s)
  if (!r.ok) throw new Error(r.error)
  return JSON.stringify(s)
}

export type SnapshotParse = { ok: true; snapshot: DetailSnapshot } | { ok: false; error: string; kind: 'corrupt' | 'unsupported-version' }

/** JSON text -> validated snapshot (an independent copy: nothing is shared with whatever produced the text). */
export function parseSnapshot(text: string): SnapshotParse {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, kind: 'corrupt', error: 'Snapshot is not valid JSON' } }
  return validateSnapshot(raw)
}
