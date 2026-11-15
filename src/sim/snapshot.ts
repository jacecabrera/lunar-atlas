// Detail snapshot: the read-only copy of one task that a Learn more tab displays. Structure and JSON conversion
// only; storage, snapshot IDs across tabs and the detail page are step 21.
//
// Everything here is plain data. Horizon functions, React objects and Worker handles never enter a snapshot;
// terrain travels as HorizonData and is rebuilt with runtimeHorizon() when needed.
import type { MissionInput, AdvancedSettings } from './mission'
import type { LegacyPowerConfig } from './power'
import type { CandidateRecord, SiteAssessment, Recommendation } from './assessment'
import type { HorizonData } from './horizonData'
import type { ModelVersions } from './task'
import type { SourceRef } from './provenance'

export const SNAPSHOT_SCHEMA = 'lunar-navigator.detail-snapshot'
export const SNAPSHOT_SCHEMA_VERSION = 1

export type SnapshotSite = {
  candidate: CandidateRecord
  assessment: SiteAssessment
  horizon: HorizonData | null
}

export type DetailSnapshot = {
  schema: typeof SNAPSHOT_SCHEMA
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  snapshotId: string
  createdAtMs: number
  /** The task this snapshot copies. */
  requestId: string
  fingerprint: string
  versions: ModelVersions
  input: MissionInput
  /** AdvancedSettings once step 05 exists; the legacy power config until then. */
  settings: AdvancedSettings | { legacyPower: LegacyPowerConfig }
  sites: SnapshotSite[]
  recommendations: Recommendation[]
  sources: SourceRef[]
}

export function serializeSnapshot(s: DetailSnapshot): string {
  return JSON.stringify(s)
}

export type SnapshotParse = { ok: true; snapshot: DetailSnapshot } | { ok: false; error: string }

/** Checks the envelope (schema, version, required top-level fields). Deeper validation can follow in step 21. */
export function parseSnapshot(text: string): SnapshotParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Snapshot is not valid JSON' }
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Snapshot must be an object' }
  const o = raw as Record<string, unknown>
  if (o.schema !== SNAPSHOT_SCHEMA) return { ok: false, error: 'Not a detail snapshot' }
  if (o.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported snapshot version ${String(o.schemaVersion)}` }
  }
  for (const key of ['snapshotId', 'requestId', 'fingerprint'] as const) {
    if (typeof o[key] !== 'string') return { ok: false, error: `Snapshot field ${key} is missing` }
  }
  if (typeof o.createdAtMs !== 'number') return { ok: false, error: 'Snapshot field createdAtMs is missing' }
  for (const key of ['sites', 'recommendations', 'sources'] as const) {
    if (!Array.isArray(o[key])) return { ok: false, error: `Snapshot field ${key} must be a list` }
  }
  if (typeof o.input !== 'object' || o.input === null) return { ok: false, error: 'Snapshot field input is missing' }
  return { ok: true, snapshot: o as unknown as DetailSnapshot }
}
