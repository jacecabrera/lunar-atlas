// Task lifecycle, result identity and version fields. Pure data and pure transitions; the scheduler that drives
// them (Worker, cancellation, caching) is step 15.
//
// Two different identities:
//   requestId    one press of "calculate". Two runs with identical inputs get different requestIds.
//   fingerprint  canonical form of everything that determines the result (inputs, settings, sites, versions).
//                Same fingerprint = same inputs; it says nothing about which run produced a result.
// A result is accepted only if its requestId is the running request. A result whose fingerprint no longer matches
// the current inputs is shown as stale.
import type { MissionInput, AdvancedSettings } from './mission'
import type { LegacyPowerConfig } from './power'
import type { SiteAssessment, Recommendation } from './assessment'
import type { RecommendationResult } from './recommend'
import type { TransitEstimate } from './transit'

// ─── Versions ──────────────────────────────────────────────────────────────

export type ModelVersions = {
  /** Version of the data contracts in this folder. Bump when a field changes meaning. */
  contract: number
  models: {
    /** Ephemeris, time scale and lunar orientation behind every Sun/Earth/Moon direction and position. */
    ephemeris: string
    visibility: string
    power: string
    terrain: string
    /** null = not implemented yet */
    scoring: string | null
    transit: string | null
  }
  data: {
    terrain: string | null
    /** Candidate catalog identity and version, e.g. 'historical-reference-sites@v0.1'. */
    candidates: string | null
    /** Settings preset identity and version, e.g. 'iln-inspired-solar-lander@v0.1'. */
    settingsPreset: string | null
  }
}

// 2: step 06 added models.ephemeris.
// 3: step 15 added TaskResult.evaluation, transits and runtime, and invalidateTask.
export const CONTRACT_VERSION = 3

// Honest labels for what the code does today. Update each label in the step that replaces the model.
export const CURRENT_MODEL_VERSIONS: ModelVersions = {
  contract: CONTRACT_VERSION,
  models: {
    // Step 06: TT from the IERS TAI - UTC offset (was the extrapolated Delta T polynomial), geometric vectors,
    // IAU lunar orientation.
    ephemeris: 'astronomy-engine@2.1.19;tt=utc+32.184s+(tai-utc)(iers-c72);ut1=utc;moon=iau-wgccre2009;vectors=geometric',
    visibility: 'visibility-v2:sun=disc-area-above-terrain+earth-occultation;earth=centre>max(terrain,min);lower-bound-aware;exact-edge-margins;events-v2:derived-rate-bounds(sun0.60,earth0.15)+scan30min+halving10s+locate1s', // steps 09-10 (sim/visibility.ts, sim/events.ts)
    power: 'pv-v1:fixed-east-west-panels;S1AU*(AU/d)^2;visible-fraction;centre-cosine;array-limit+energy-v2:base+comm*I_E;bus-eff;charge/discharge-eff;limits;reserve;midpoint<=5min+half-step-check;pv-rate-bound;bounds', // steps 11-12 (sim/pv.ts, sim/energy.ts)
    // Step 07: per-candidate NAC DTM near field + SLDEM2015 / LOLA polar mid and far fields, precomputed horizons with
    // coverage; LDEM_4 remains the preview path for other points. No footprint assessment yet (step 08).
    terrain: 'terrain-v1.1:nac+sldem2015|ldem60s;horizon=multi-source-0.5deg-200km;observer=dtm-elevation+0m;horizon-gate=coverage+quality+convergence-0.05deg;footprint=footprint-v2(unknown-statistic=no-decision)',
    scoring: 'score-v1.1:data-completeness=pass|unknown|error;S=100*(wL*L+wC*C+wT*T);T=clamp(1-slope/limit);tie=round(S*100);historical-first;spread=maximin-great-circle;stable-id', // step 13 (sim/recommend.ts)
    transit: 'transit-v1:tau=|rE(tL-tau)-rM(tL)|/v;EQJ-geocentric-geometric;fixed-point+illinois;residual<=1ms', // step 14 (sim/transit.ts)
  },
  data: {
    terrain: 'terrain-v1.1', // published site terrain data version (files in public/data/terrain/v1)
    candidates: null, // set from the loaded catalog with withDataVersions()
    settingsPreset: null, // set from the loaded defaults with withDataVersions()
  },
}

/**
 * Versions with the identities of the catalog and settings preset that a task actually used. The identities are the
 * file's own fixed IDs and versions, never a load time, so the same files always give the same fingerprint.
 */
export function withDataVersions(
  base: ModelVersions,
  data: { catalog: { catalogId: string; dataVersion: string }; defaults: { presetId: string; dataVersion: string } },
): ModelVersions {
  return {
    ...base,
    data: {
      ...base.data,
      candidates: `${data.catalog.catalogId}@${data.catalog.dataVersion}`,
      settingsPreset: `${data.defaults.presetId}@${data.defaults.dataVersion}`,
    },
  }
}

// ─── Identity ──────────────────────────────────────────────────────────────

let requestSeq = 0

/** Unique within a page session. Avoids crypto.randomUUID, which is missing on non-secure (plain http) origins. */
export function createRequestId(nowMs = Date.now()): string {
  requestSeq += 1
  return `req-${nowMs.toString(36)}-${requestSeq.toString(36)}`
}

/** What determines a task result. */
export type FingerprintInput = {
  input: MissionInput
  settings: AdvancedSettings | { legacyPower: LegacyPowerConfig }
  siteIds: string[]
  versions: ModelVersions
}

// JSON with object keys sorted at every level, so key order never changes the fingerprint.
// Array order is kept: site order is meaningful.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Fingerprint values must be finite')
    if (value === undefined || typeof value === 'function') throw new Error('Fingerprint values must be plain data')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

/** Exact canonical string (not a hash), so different inputs can never collide. */
export function taskFingerprint(f: FingerprintInput): string {
  return canonical(f)
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export type TaskRequest = {
  requestId: string
  fingerprint: string
  versions: ModelVersions
  startedAtMs: number
}

/**
 * A completed task. Zero recommendations is a normal outcome ('no-eligible-sites'), not an error.
 * sites holds every evaluated site, including those excluded and the reasons why.
 */
export type TaskResult = {
  requestId: string
  fingerprint: string
  versions: ModelVersions
  completedAtMs: number
  sites: SiteAssessment[]
  recommendations: Recommendation[]
  outcome: 'recommendations' | 'no-eligible-sites'
  /** Step 13: ranking and the reasons for every exclusion (physical failure, insufficient data, service error). */
  evaluation?: Pick<RecommendationResult, 'ranked' | 'excluded' | 'weights' | 'model'>
  /** Step 14: transit estimates of the recommended sites; a failed estimate does not change the lunar assessment. */
  transits?: Record<string, TransitEstimate>
  /** Step 15: runtime facts of the computing thread (time-scale model, TT - UTC at landing, job protocol). */
  runtime?: { timeScaleModel: string; ttMinusUtcSecondsAtLanding: number; protocol: number }
}

/** Task-level failure (service unavailable, unexpected exception). Per-site data gaps are conditions, not this. */
export type TaskError = { requestId: string; kind: 'service' | 'internal'; message: string }

/**
 * - idle     nothing calculated; whether inputs are empty or invalid comes from missionInputStatus()
 * - running  one request in flight
 * - done     result matches the inputs it was computed for
 * - stale    inputs or settings changed after completion; the old result is kept but marked out of date
 * - error    the request failed
 */
export type TaskState =
  | { status: 'idle' }
  | { status: 'running'; request: TaskRequest }
  | { status: 'done'; request: TaskRequest; result: TaskResult }
  | { status: 'stale'; request: TaskRequest; result: TaskResult }
  | { status: 'error'; request: TaskRequest; error: TaskError }

export const IDLE_TASK: TaskState = { status: 'idle' }

export function startTask(request: TaskRequest): TaskState {
  return { status: 'running', request }
}

/** Accept a result only from the request currently running; late or foreign results leave the state unchanged. */
export function completeTask(state: TaskState, result: TaskResult): TaskState {
  if (state.status !== 'running' || state.request.requestId !== result.requestId) return state
  if (state.request.fingerprint !== result.fingerprint) {
    throw new Error('Result fingerprint does not match its request')
  }
  return { status: 'done', request: state.request, result }
}

export function failTask(state: TaskState, error: TaskError): TaskState {
  if (state.status !== 'running' || state.request.requestId !== error.requestId) return state
  return { status: 'error', request: state.request, error }
}

/**
 * Call when the main inputs or the relevant settings change: a running request loses the right to write back
 * (idle; its messages are ignored by requestId), a done result becomes stale, an error no longer applies (idle).
 */
export function invalidateTask(state: TaskState): TaskState {
  if (state.status === 'running' || state.status === 'error') return IDLE_TASK
  if (state.status === 'done') return { ...state, status: 'stale' }
  return state
}

/** Call after inputs change. A done result whose fingerprint differs from the current one becomes stale. */
export function markStaleIfChanged(state: TaskState, currentFingerprint: string | null): TaskState {
  if (state.status !== 'done') return state
  return state.result.fingerprint === currentFingerprint ? state : { ...state, status: 'stale' }
}
