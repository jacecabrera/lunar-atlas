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
// Types and validation only. The ILN-inspired preset is loaded from src/data/lunar-mission-defaults-v0.1.json by
// defaults.ts. The legacy power model keeps its own isolated LegacyPowerConfig (see power.ts).

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
  /**
   * Minimum reserve as a fraction of capacity. The single source of the reserve: use reserveEnergyWh() for Wh, so
   * the fraction and the energy can never disagree. Reaching it while still needing net discharge is a failure.
   */
  reserveFraction: number
  /** Battery charge efficiency (bus -> storage), fraction. Distinct from pvEfficiency and busEfficiency. */
  chargeEfficiency: number
  /** Battery discharge efficiency (storage -> bus), fraction. */
  dischargeEfficiency: number
  /** Bus-side battery charge power limit, W. */
  chargeLimitW: number
  /** Bus-side battery discharge power limit, W. Net demand above it is an immediate supply failure. */
  dischargeLimitW: number
}

/** Reserve energy in Wh, derived from the capacity and the reserve fraction. */
export const reserveEnergyWh = (d: Pick<DeviceConfig, 'batteryCapacityWh' | 'reserveFraction'>) =>
  d.batteryCapacityWh * d.reserveFraction

export const totalPanelAreaM2 = (d: Pick<DeviceConfig, 'panels'>) => d.panels.reduce((a, p) => a + p.areaM2, 0)

/** Score weights for S = 100 x (wL L + wC C + wT T). Normalised before use; all zero is invalid. */
export type ScoringWeights = { sunlight: number; earth: number; terrain: number }

/** Weights scaled to sum to 1, or null when they are invalid (negative, non-finite or all zero). */
export function normalizeWeights(w: ScoringWeights): ScoringWeights | null {
  const v = [w.sunlight, w.earth, w.terrain]
  if (v.some((x) => !Number.isFinite(x) || x < 0)) return null
  const sum = v[0] + v[1] + v[2]
  if (!(sum > 0)) return null
  return { sunlight: w.sunlight / sum, earth: w.earth / sum, terrain: w.terrain / sum }
}

/** Parameters of the solar input model. */
export type SolarModelParams = {
  /** Irradiance at the reference distance, W/m2. */
  irradianceWm2: number
  /** Distance at which irradianceWm2 applies, AU; scale by the inverse square of the actual Sun distance. */
  referenceDistanceAu: number
  /** Extra loss factor k_loss. 1 means "not modelled", not "no loss exists". */
  lossFactor: number
}

export type AdvancedSettings = {
  /** Preset identity, for result fingerprints. */
  presetId: string
  presetVersion: string
  device: DeviceConfig
  /** Assumptions about how the device is operated. */
  operation: {
    /** The base load applies for the whole mission, not only at night. */
    baseLoadContinuous: boolean
    /** Communication load is on during every geometric Earth-visibility interval. */
    commAlwaysOnWhenEarthVisible: boolean
  }
  model: SolarModelParams
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
  limits: { maxRecommendations: number; maxCustomSites: number }
  /** Provenance of each value, keyed by the parameter key in the defaults file (e.g. 'device.busEfficiency'). */
  provenance: Partial<Record<string, ParameterProvenance>>
}

/** Problems that make the settings unusable; an empty list means valid. Messages are shown in the UI. */
export function validateAdvancedSettings(s: AdvancedSettings): string[] {
  const e: string[] = []
  const d = s.device
  const pos = (v: number, label: string) => { if (!Number.isFinite(v) || v <= 0) e.push(`${label} must be a positive number`) }
  const frac = (v: number, label: string) => { if (!Number.isFinite(v) || v <= 0 || v > 1) e.push(`${label} must be greater than 0 and at most 1`) }
  frac(d.pvEfficiency, 'Solar efficiency')
  frac(d.busEfficiency, 'Energy use efficiency')
  frac(d.chargeEfficiency, 'Battery charge efficiency')
  frac(d.dischargeEfficiency, 'Battery discharge efficiency')
  pos(d.pvOutputLimitW, 'Solar output limit')
  pos(d.chargeLimitW, 'Battery charge power limit')
  pos(d.dischargeLimitW, 'Battery discharge power limit')
  pos(d.batteryCapacityWh, 'Battery capacity')
  if (!Number.isFinite(d.baseLoadW) || d.baseLoadW < 0) e.push('Base load must be non-negative')
  if (!Number.isFinite(d.commLoadW) || d.commLoadW < 0) e.push('Communication load must be non-negative')
  if (!Number.isFinite(d.initialEnergyWh) || d.initialEnergyWh < 0) e.push('Initial stored energy must be non-negative')
  if (!Number.isFinite(d.reserveFraction) || d.reserveFraction < 0 || d.reserveFraction >= 1) e.push('Reserve fraction must be at least 0 and below 1')
  if (e.length === 0) {
    if (d.initialEnergyWh > d.batteryCapacityWh) e.push('Initial stored energy must not exceed battery capacity')
    if (reserveEnergyWh(d) > d.initialEnergyWh) e.push('Minimum reserve must not exceed initial stored energy')
  }
  if (d.panels.length === 0) e.push('At least one panel is required')
  for (const p of d.panels) {
    pos(p.areaM2, `Panel ${p.id} area`)
    if (!Number.isFinite(p.azimuthDeg)) e.push(`Panel ${p.id} azimuth must be finite`)
    if (!Number.isFinite(p.tiltDeg) || p.tiltDeg < 0 || p.tiltDeg > 90) e.push(`Panel ${p.id} tilt must be between 0 and 90 degrees`)
  }
  pos(s.model.irradianceWm2, 'Solar irradiance')
  pos(s.model.referenceDistanceAu, 'Solar reference distance')
  if (!Number.isFinite(s.model.lossFactor) || s.model.lossFactor <= 0 || s.model.lossFactor > 1) e.push('Loss factor must be greater than 0 and at most 1')
  pos(s.transitSpeedKmPerS, 'Effective transit speed')
  if (!Number.isFinite(s.earthMinElevationDeg) || s.earthMinElevationDeg < -90 || s.earthMinElevationDeg > 90) e.push('Minimum Earth elevation must be between -90 and 90 degrees')
  pos(s.footprintDiameterM, 'Footprint diameter')
  pos(s.slopeLimitDeg, 'Slope limit')
  pos(s.obstacleLimitM, 'Obstacle height limit')
  if (normalizeWeights(s.weights) === null) e.push('Score weights must be non-negative and not all zero')
  for (const [k, v] of Object.entries(s.limits)) {
    if (!Number.isInteger(v) || v < 0) e.push(`${k} must be a non-negative whole number`)
  }
  return e
}
