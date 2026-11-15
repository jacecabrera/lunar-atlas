// Mission inputs and advanced settings.
//
// Two layers on purpose:
//   MissionDraft  what the user has typed so far. Every field may be null (not filled in yet) or invalid.
//   MissionInput  a validated, complete input. Only validateMissionDraft() produces one, so NaN, Infinity,
//                 empty or out-of-range values never reach a calculation.
// The three main inputs start empty (v0.7 §2): no default "now", no default duration, no default 0/0 launch site.
import { MAX_DATE_MS, daysToMs } from './units'
import type { ParameterProvenance } from './provenance'

// ─── Main inputs ───────────────────────────────────────────────────────────

export type MissionDraft = {
  /** Landing Time: touchdown instant, UTC ms. The surface mission starts at touchdown. */
  landingTimeMs: number | null
  /** Duration of journey: length of the surface mission in Earth days (24 h). Not the Earth-Moon transit time. */
  durationDays: number | null
  /** Launch site on Earth, degrees, north positive. */
  launchLat: number | null
  /** Launch site on Earth, degrees, east positive, -180..180. */
  launchLon: number | null
}

export const EMPTY_MISSION_DRAFT: Readonly<MissionDraft> = Object.freeze({
  landingTimeMs: null,
  durationDays: null,
  launchLat: null,
  launchLon: null,
})

export type GeoPoint = { lat: number; lon: number }

export type MissionInput = {
  landingTimeMs: number
  /** Surface mission length in ms (converted from Earth days at the input boundary). */
  durationMs: number
  launchSite: GeoPoint
}

/** Absolute UTC analysis window [startMs, endMs] = [landing, landing + duration]. No sunrise or deployment wait. */
export type MissionWindow = { startMs: number; endMs: number }

export function missionWindow(input: MissionInput): MissionWindow {
  return { startMs: input.landingTimeMs, endMs: input.landingTimeMs + input.durationMs }
}

// ─── Validation ────────────────────────────────────────────────────────────

export type MissionField = keyof MissionDraft
export type FieldErrorCode = 'required' | 'not-finite' | 'not-positive' | 'out-of-range'
export type FieldError = { field: MissionField; code: FieldErrorCode; message: string }

export type MissionValidation =
  | { ok: true; input: MissionInput; errors: [] }
  | { ok: false; input: null; errors: FieldError[] }

const LABELS: Record<MissionField, string> = {
  landingTimeMs: 'Landing Time',
  durationDays: 'Duration of journey',
  launchLat: 'Launch site latitude',
  launchLon: 'Launch site longitude',
}

// Returns an error for a missing or non-finite value, otherwise null.
function presence(field: MissionField, v: number | null): FieldError | null {
  if (v === null) return { field, code: 'required', message: `${LABELS[field]} is required` }
  if (!Number.isFinite(v)) return { field, code: 'not-finite', message: `${LABELS[field]} must be a finite number` }
  return null
}

function range(field: MissionField, v: number, min: number, max: number, unit: string): FieldError | null {
  return v < min || v > max
    ? { field, code: 'out-of-range', message: `${LABELS[field]} must be between ${min} and ${max} ${unit}` }
    : null
}

export function validateMissionDraft(d: MissionDraft): MissionValidation {
  const errors: FieldError[] = []
  const push = (e: FieldError | null) => { if (e) errors.push(e) }

  const tErr = presence('landingTimeMs', d.landingTimeMs)
    ?? range('landingTimeMs', d.landingTimeMs!, -MAX_DATE_MS, MAX_DATE_MS, 'ms')
  push(tErr)

  const dErr = presence('durationDays', d.durationDays)
  if (dErr) push(dErr)
  else if (d.durationDays! <= 0) {
    push({ field: 'durationDays', code: 'not-positive', message: `${LABELS.durationDays} must be greater than 0 days` })
  } else if (!tErr && Math.abs(d.landingTimeMs! + daysToMs(d.durationDays!)) > MAX_DATE_MS) {
    // Only checked against a valid landing time, so one bad field does not produce two errors.
    push({ field: 'durationDays', code: 'out-of-range', message: `${LABELS.durationDays} ends outside the supported date range` })
  }

  push(presence('launchLat', d.launchLat) ?? range('launchLat', d.launchLat!, -90, 90, 'degrees'))
  push(presence('launchLon', d.launchLon) ?? range('launchLon', d.launchLon!, -180, 180, 'degrees'))

  if (errors.length > 0) return { ok: false, input: null, errors }
  return {
    ok: true,
    errors: [],
    input: {
      landingTimeMs: d.landingTimeMs!,
      durationMs: daysToMs(d.durationDays!),
      launchSite: { lat: d.launchLat!, lon: d.launchLon! },
    },
  }
}

/** 'empty' = nothing entered yet; 'invalid' = partly filled or out of range; 'valid' = ready to calculate. */
export type MissionInputStatus = 'empty' | 'invalid' | 'valid'

export function missionInputStatus(d: MissionDraft): MissionInputStatus {
  if (Object.values(d).every((v) => v === null)) return 'empty'
  return validateMissionDraft(d).ok ? 'valid' : 'invalid'
}

export function validateMissionWindow(w: MissionWindow): string[] {
  const errors: string[] = []
  if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) errors.push('Mission window bounds must be finite')
  else if (w.endMs <= w.startMs) errors.push('Mission window must end after it starts')
  return errors
}

// ─── Advanced settings (More settings) ─────────────────────────────────────
// Types only. The ILN-inspired preset values and their provenance are added in step 05; until then no instance
// of DeviceConfig exists, and the legacy power model uses its own isolated LegacyPowerConfig (see power.ts).

/** A fixed flat panel. The normal points along azimuthDeg (clockwise from local north), tilted tiltDeg up from horizontal. */
export type PanelSpec = { id: string; areaM2: number; azimuthDeg: number; tiltDeg: number }

export type DeviceConfig = {
  /** Photovoltaic conversion efficiency (the user's "recharge efficiency"), fraction. The only PV efficiency input. */
  pvEfficiency: number
  panels: PanelSpec[]
  /** Upper limit of PV controller output, W. A cap, not a multiplier in the area formula. */
  pvOutputLimitW: number
  /** Continuous base load at the device electrical input, W. */
  baseLoadW: number
  /** Extra communication load while Earth is geometrically visible, W at the device input. */
  commLoadW: number
  /** Energy use efficiency: common bus to device input, fraction. Applied once. */
  busEfficiency: number
  /** Battery capacity, Wh at the internal storage terminal. */
  batteryCapacityWh: number
  /** Initial stored energy, Wh at the internal storage terminal. */
  initialEnergyWh: number
  /** Minimum reserve, Wh. Reaching it while still needing net discharge is a failure. */
  reserveWh: number
  /** Battery charge efficiency (bus -> storage), fraction. Distinct from pvEfficiency and busEfficiency. */
  chargeEfficiency: number
  /** Battery discharge efficiency (storage -> bus), fraction. */
  dischargeEfficiency: number
  /** Bus-side battery charge power limit, W. */
  chargeLimitW: number
  /** Bus-side battery discharge power limit, W. Net demand above it is an immediate supply failure. */
  dischargeLimitW: number
}

/** Score weights for S = 100 x (wL L + wC C + wT T). Normalised before use; all zero is invalid. */
export type ScoringWeights = { sunlight: number; earth: number; terrain: number }

export type AdvancedSettings = {
  device: DeviceConfig
  /** Effective transit speed for the simplified distance/time estimate, km/s. */
  transitSpeedKmPerS: number
  /** Minimum elevation of Earth's disc centre for communication geometry, degrees. */
  earthMinElevationDeg: number
  /** Local terrain analysis footprint diameter, m. */
  footprintDiameterM: number
  /** Slope at or above this is excluded, degrees. */
  slopeLimitDeg: number
  /** Known obstacles at or above this height are excluded, m. */
  obstacleLimitM: number
  weights: ScoringWeights
  /** Provenance of each preset value (source value, derived or project assumption). */
  provenance: Partial<Record<string, ParameterProvenance>>
}
