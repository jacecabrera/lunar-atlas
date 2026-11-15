// LEGACY power viability model (pre-v0.7). Kept so existing behaviour stays comparable while the contracts change.
//
// Solar generation model: binary. If any part of the Sun's disc is above the horizon, the panel produces its
// maximum rated output. No panel geometry, no partial disc, no efficiencies, no power limits. This conflicts with
// requirements v0.7 §5 and is replaced in steps 11 and 12. See sources.md for the full list of assumptions.
//
// Step 03 changed the interface only:
//   - units are W and Wh (energy at the battery's internal terminal), integration in hours
//   - the mission duration is no longer part of the config; it comes from a MissionWindow (absolute UTC ms)
//   - schedule segments use offsets from the mission start (startOffsetMs/endOffsetMs)
//   - kW/kWh callers go through legacyPowerConfigFromKw()
// The per-step arithmetic is unchanged.
//
// `viable` describes this legacy energy model only. It is not landing eligibility and must not be mapped to a
// 'pass' power condition in the new assessment flow.

import type { Interval, VisibilityOptions } from '../physics/siteTimeline'
import type { MissionWindow } from './mission'
import { validateMissionWindow } from './mission'
import type { Site } from './site'
import { windows } from './site'
import { MS_PER_MINUTE, msToHours, kwToW, kwhToWh } from './units'

// ─── Configuration ─────────────────────────────────────────────────────────

export type LegacyPowerConfig = {
  /** Normal vessel power consumption, W */
  normalLoadW: number
  /** Essential-system power consumption, W. Validated but not used by the simulation; removed or isolated in step 12. */
  essentialLoadW: number
  /** Initial stored energy, Wh */
  initialEnergyWh: number
  /** Battery capacity, Wh */
  capacityWh: number
  /** Panel output whenever any part of the Sun is visible (binary model), W */
  maxSolarW: number
  /** Minimum reserve that must not be breached, Wh */
  minReserveWh: number
}

// Placeholder values for the legacy model only. Arbitrary, NOT researched and NOT the ILN-inspired preset of
// step 05 (same physical values as the former DEFAULT_POWER_CONFIG, converted from kW/kWh).
export const LEGACY_PLACEHOLDER_POWER_CONFIG: Readonly<LegacyPowerConfig> = Object.freeze({
  normalLoadW: 2000,
  essentialLoadW: 500,
  initialEnergyWh: 50_000,
  capacityWh: 100_000,
  maxSolarW: 4000,
  minReserveWh: 10_000,
})

/** The former kW/kWh field set, for callers that still hold values in those units. */
export type LegacyPowerConfigKw = {
  normalLoadKw: number
  essentialLoadKw: number
  initialChargeKwh: number
  maxCapacityKwh: number
  maxSolarKw: number
  minReserveKwh: number
}

/** Explicit kW/kWh -> W/Wh adapter. Converts values; it does not just rename fields. */
export function legacyPowerConfigFromKw(c: LegacyPowerConfigKw): LegacyPowerConfig {
  return {
    normalLoadW: kwToW(c.normalLoadKw),
    essentialLoadW: kwToW(c.essentialLoadKw),
    initialEnergyWh: kwhToWh(c.initialChargeKwh),
    capacityWh: kwhToWh(c.maxCapacityKwh),
    maxSolarW: kwToW(c.maxSolarKw),
    minReserveWh: kwhToWh(c.minReserveKwh),
  }
}

// ─── Time-dependent power schedule ─────────────────────────────────────────

/** A segment of the mission with a specific load. Offsets are ms from the mission start (landing), not UTC.
 *  Segments must cover the whole mission without gaps or overlaps. Without a schedule the normal load is used. */
export type PowerSegment = {
  startOffsetMs: number
  endOffsetMs: number
  loadW: number
}

export type PowerSchedule = PowerSegment[]

// ─── Validation ────────────────────────────────────────────────────────────

export type ValidationError = { field: string; message: string }

export function validateConfig(c: LegacyPowerConfig): ValidationError[] {
  const errors: ValidationError[] = []
  const pos = (f: string, v: number, label: string) => {
    if (!Number.isFinite(v) || v <= 0) errors.push({ field: f, message: `${label} must be a positive number` })
  }
  const nonNeg = (f: string, v: number, label: string) => {
    if (!Number.isFinite(v) || v < 0) errors.push({ field: f, message: `${label} must be non-negative` })
  }
  pos('normalLoadW', c.normalLoadW, 'Normal power consumption')
  pos('essentialLoadW', c.essentialLoadW, 'Essential-system power consumption')
  nonNeg('initialEnergyWh', c.initialEnergyWh, 'Initial stored energy')
  pos('capacityWh', c.capacityWh, 'Battery capacity')
  pos('maxSolarW', c.maxSolarW, 'Maximum solar output')
  nonNeg('minReserveWh', c.minReserveWh, 'Minimum battery reserve')

  if (errors.length === 0) {
    if (c.essentialLoadW > c.normalLoadW) {
      errors.push({ field: 'essentialLoadW', message: 'Essential-system load must not exceed normal load' })
    }
    if (c.initialEnergyWh > c.capacityWh) {
      errors.push({ field: 'initialEnergyWh', message: 'Initial stored energy must not exceed battery capacity' })
    }
    if (c.minReserveWh > c.capacityWh) {
      errors.push({ field: 'minReserveWh', message: 'Minimum reserve must not exceed battery capacity' })
    }
    if (c.minReserveWh > c.initialEnergyWh) {
      errors.push({ field: 'minReserveWh', message: 'Minimum reserve must not exceed initial stored energy' })
    }
  }
  return errors
}

export function validateSchedule(schedule: PowerSchedule, durationMs: number): ValidationError[] {
  const errors: ValidationError[] = []
  if (schedule.length === 0) return errors
  const sorted = [...schedule].sort((a, b) => a.startOffsetMs - b.startOffsetMs)
  if (sorted[0].startOffsetMs !== 0) {
    errors.push({ field: 'schedule', message: 'Schedule must start at offset 0 (landing)' })
  }
  const last = sorted[sorted.length - 1]
  if (Math.abs(last.endOffsetMs - durationMs) > 1) {
    errors.push({ field: 'schedule', message: `Schedule must end at offset ${durationMs} ms (the mission duration)` })
  }
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]
    if (!Number.isFinite(seg.loadW) || seg.loadW < 0) {
      errors.push({ field: 'schedule', message: `Segment ${i}: load must be non-negative` })
    }
    if (seg.endOffsetMs <= seg.startOffsetMs) {
      errors.push({ field: 'schedule', message: `Segment ${i}: end must be after start` })
    }
    if (i > 0 && Math.abs(seg.startOffsetMs - sorted[i - 1].endOffsetMs) > 1) {
      errors.push({ field: 'schedule', message: `Gap or overlap between segments ${i - 1} and ${i}` })
    }
  }
  return errors
}

// ─── Simulation state (per time step) ──────────────────────────────────────

export type PowerState = {
  tMs: number              // absolute UTC ms
  sunUp: boolean
  solarW: number           // generation this step (0 or maxSolarW)
  loadW: number            // consumption this step
  netW: number             // solar - load (positive = charging)
  energyWh: number         // stored energy after this step
  deficitWh: number        // cumulative unmet energy demand
  reserveBreached: boolean // energy < minReserve at any point up to here
}

// ─── Result ────────────────────────────────────────────────────────────────

export type LegacyPowerResult = {
  /** Legacy energy model only; not landing eligibility. */
  viable: boolean
  reason: string | null         // null if viable
  totalSolarWh: number
  totalConsumedWh: number
  lowestEnergyWh: number
  lowestEnergyAtMs: number      // absolute UTC ms
  minReserveMarginWh: number    // lowestEnergy - minReserve (negative = breached)
  totalDeficitWh: number
  timeline: PowerState[]        // one entry per simulation step
  sunIntervals: Interval[]      // absolute UTC ms
}

// ─── Simulation engine ─────────────────────────────────────────────────────

export type SimulateOptions = {
  /** Simulation time step in ms. Default 5 minutes. Shorter = more accurate near transitions. */
  dtMs?: number
  /** Time-dependent power schedule (offsets from landing). If omitted, config.normalLoadW is used throughout. */
  schedule?: PowerSchedule
  /** Optional callback for future degradation modelling: (state, config) => adjusted capacityWh. */
  degradation?: (state: PowerState, config: LegacyPowerConfig) => number
}

function loadAt(schedule: PowerSchedule | undefined, normalW: number, offsetMs: number): number {
  if (!schedule || schedule.length === 0) return normalW
  for (const seg of schedule) {
    if (offsetMs >= seg.startOffsetMs && offsetMs < seg.endOffsetMs) return seg.loadW
  }
  return normalW
}

/** Is the absolute time tMs inside any of the sun-up intervals? Binary search. */
function isSunUp(intervals: Interval[], tMs: number): boolean {
  let lo = 0
  let hi = intervals.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (tMs < intervals[mid].start) hi = mid - 1
    else if (tMs >= intervals[mid].end) lo = mid + 1
    else return true
  }
  return false
}

// Every public entry point validates the same way (simulatePower used to skip validation).
function assertValid(config: LegacyPowerConfig, window: MissionWindow, opts: SimulateOptions) {
  const msgs = [
    ...validateMissionWindow(window),
    ...validateConfig(config).map((e) => e.message),
  ]
  if (opts.dtMs !== undefined && !(opts.dtMs > 0 && Number.isFinite(opts.dtMs))) msgs.push('dtMs must be a positive number')
  if (msgs.length === 0 && opts.schedule) {
    msgs.push(...validateSchedule(opts.schedule, window.endMs - window.startMs).map((e) => e.message))
  }
  if (msgs.length > 0) throw new Error(`Invalid power simulation input: ${msgs.join('; ')}`)
}

/**
 * Chronological battery simulation over the mission window, using pre-computed sun-up intervals
 * (absolute UTC ms) from windows('sun', ...).
 *
 * At each step: generation = maxSolarW if the Sun is up else 0; load from the schedule or normalLoadW;
 * energy += net x dt (hours), clamped to [0, capacity]; shortfall below 0 is recorded as deficit;
 * a reserve breach is sticky.
 */
export function simulatePower(
  config: LegacyPowerConfig,
  window: MissionWindow,
  sunIntervals: Interval[],
  opts: SimulateOptions = {},
): LegacyPowerResult {
  assertValid(config, window, opts)
  const dtMs = opts.dtMs ?? 5 * MS_PER_MINUTE
  const schedule = opts.schedule
  const durationMs = window.endMs - window.startMs

  let energy = config.initialEnergyWh
  let totalSolar = 0
  let totalConsumed = 0
  let deficit = 0
  let lowest = energy
  let lowestAtOffset = 0
  let reserveBreached = false

  const timeline: PowerState[] = []
  const steps = Math.ceil(durationMs / dtMs)

  for (let i = 0; i <= steps; i++) {
    const offsetMs = Math.min(i * dtMs, durationMs)
    const sunUp = isSunUp(sunIntervals, window.startMs + offsetMs)
    const solarW = sunUp ? config.maxSolarW : 0
    const loadW = loadAt(schedule, config.normalLoadW, offsetMs)
    const netW = solarW - loadW

    if (i > 0) {
      const dtH = msToHours(Math.min(dtMs, durationMs - (i - 1) * dtMs))
      const cap = opts.degradation ? opts.degradation(timeline[timeline.length - 1], config) : config.capacityWh
      const raw = energy + netW * dtH

      totalSolar += solarW * dtH
      totalConsumed += loadW * dtH

      if (raw < 0) {
        deficit += -raw
        energy = 0
      } else {
        energy = Math.min(raw, cap)
      }
    }

    if (energy < lowest) {
      lowest = energy
      lowestAtOffset = offsetMs
    }
    if (energy < config.minReserveWh) reserveBreached = true

    timeline.push({
      tMs: window.startMs + offsetMs,
      sunUp, solarW, loadW, netW,
      energyWh: energy,
      deficitWh: deficit,
      reserveBreached,
    })
  }

  let reason: string | null = null
  if (deficit > 0) reason = 'Battery depleted: unmet energy demand'
  else if (reserveBreached) reason = 'Battery charge fell below minimum reserve'

  return {
    viable: reason === null,
    reason,
    totalSolarWh: totalSolar,
    totalConsumedWh: totalConsumed,
    lowestEnergyWh: lowest,
    lowestEnergyAtMs: window.startMs + lowestAtOffset,
    minReserveMarginWh: lowest - config.minReserveWh,
    totalDeficitWh: deficit,
    timeline,
    sunIntervals,
  }
}

// ─── Viability assessment ──────────────────────────────────────────────────

export type AssessOptions = SimulateOptions & {
  /** Visibility options passed to windows() for the sun-up calculation. */
  visibility?: VisibilityOptions
  /** Step size for the sun-window scan in ms. Default 30 min (same as siteTimeline). */
  windowStepMs?: number
}

/**
 * Sun-up windows for the site over the mission window, then the chronological battery simulation.
 * A Site without a horizon is a smooth sphere; this legacy path does not check terrain availability.
 */
export function assessViability(
  site: Site,
  window: MissionWindow,
  config: LegacyPowerConfig,
  opts: AssessOptions = {},
): LegacyPowerResult {
  assertValid(config, window, opts)
  const sunIntervals = windows(site, 'sun', window.startMs, window.endMs, {
    ...opts.visibility,
    stepMs: opts.windowStepMs,
  })
  return simulatePower(config, window, sunIntervals, opts)
}

/**
 * Only the verdict of assessViability. It still runs the full simulation and builds the whole timeline, so it is
 * not a fast pre-screen.
 */
export function isViable(
  site: Site,
  window: MissionWindow,
  config: LegacyPowerConfig,
  opts: AssessOptions = {},
): { viable: boolean; reason: string | null } {
  const r = assessViability(site, window, config, opts)
  return { viable: r.viable, reason: r.reason }
}
