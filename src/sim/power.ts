// Power viability assessment for lunar landing sites.
// Determines whether a spacecraft can sustain its electrical requirements
// throughout a specified stay, using the existing environmental simulation.
//
// Solar generation model: binary. If any part of the Sun's disc is above the
// horizon (sunUp from skyAt), the panel produces its maximum rated output.
// No elevation-based attenuation, no partial-illumination scaling.
// See sources.md for the full list of assumptions.

import type { Interval } from '../physics/siteTimeline'

// ─── User inputs ───────────────────────────────────────────────────────────

export type PowerConfig = {
  /** Mission duration in milliseconds */
  stayMs: number
  /** Normal vessel power consumption, kW */
  normalLoadKw: number
  /** Essential-system power consumption (reduced operating mode), kW */
  essentialLoadKw: number
  /** Initial battery charge, kWh */
  initialChargeKwh: number
  /** Maximum battery capacity, kWh */
  maxCapacityKwh: number
  /** Maximum solar recharge rate (panel output under ideal direct sunlight), kW */
  maxSolarKw: number
  /** Minimum battery reserve that must not be breached, kWh */
  minReserveKwh: number
}

// Provisional placeholder defaults. These are NOT based on researched spacecraft
// specifications and exist only so the UI has something to show before the user edits.
export const DEFAULT_POWER_CONFIG: PowerConfig = {
  stayMs: 14 * 24 * 3_600_000, // 14 Earth days (~half a lunar day)
  normalLoadKw: 2.0,
  essentialLoadKw: 0.5,
  initialChargeKwh: 50,
  maxCapacityKwh: 100,
  maxSolarKw: 4.0,
  minReserveKwh: 10,
}

// ─── Time-dependent power schedule ─────────────────────────────────────────

/** A segment of the mission with a specific power load. Segments must cover
 *  the entire mission without gaps or overlaps. If none is supplied, the
 *  normal load is used throughout. */
export type PowerSegment = {
  startMs: number
  endMs: number
  loadKw: number
}

export type PowerSchedule = PowerSegment[]

// ─── Validation ────────────────────────────────────────────────────────────

export type ValidationError = { field: string; message: string }

export function validateConfig(c: PowerConfig): ValidationError[] {
  const errors: ValidationError[] = []
  const pos = (f: string, v: number, label?: string) => {
    if (!Number.isFinite(v) || v <= 0) errors.push({ field: f, message: `${label ?? f} must be a positive number` })
  }
  const nonNeg = (f: string, v: number, label?: string) => {
    if (!Number.isFinite(v) || v < 0) errors.push({ field: f, message: `${label ?? f} must be non-negative` })
  }
  pos('stayMs', c.stayMs, 'Length of stay')
  pos('normalLoadKw', c.normalLoadKw, 'Normal power consumption')
  pos('essentialLoadKw', c.essentialLoadKw, 'Essential-system power consumption')
  nonNeg('initialChargeKwh', c.initialChargeKwh, 'Initial battery charge')
  pos('maxCapacityKwh', c.maxCapacityKwh, 'Maximum battery capacity')
  pos('maxSolarKw', c.maxSolarKw, 'Maximum solar recharge rate')
  nonNeg('minReserveKwh', c.minReserveKwh, 'Minimum battery reserve')

  if (errors.length === 0) {
    if (c.essentialLoadKw > c.normalLoadKw) {
      errors.push({ field: 'essentialLoadKw', message: 'Essential-system load must not exceed normal load' })
    }
    if (c.initialChargeKwh > c.maxCapacityKwh) {
      errors.push({ field: 'initialChargeKwh', message: 'Initial charge must not exceed maximum capacity' })
    }
    if (c.minReserveKwh > c.maxCapacityKwh) {
      errors.push({ field: 'minReserveKwh', message: 'Minimum reserve must not exceed maximum capacity' })
    }
    if (c.minReserveKwh > c.initialChargeKwh) {
      errors.push({ field: 'minReserveKwh', message: 'Minimum reserve must not exceed initial charge' })
    }
  }
  return errors
}

export function validateSchedule(schedule: PowerSchedule, stayMs: number): ValidationError[] {
  const errors: ValidationError[] = []
  if (schedule.length === 0) return errors
  const sorted = [...schedule].sort((a, b) => a.startMs - b.startMs)
  if (sorted[0].startMs !== 0) {
    errors.push({ field: 'schedule', message: 'Schedule must start at time 0' })
  }
  const last = sorted[sorted.length - 1]
  if (Math.abs(last.endMs - stayMs) > 1) {
    errors.push({ field: 'schedule', message: `Schedule must end at ${stayMs} ms (the mission duration)` })
  }
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]
    if (!Number.isFinite(seg.loadKw) || seg.loadKw < 0) {
      errors.push({ field: 'schedule', message: `Segment ${i}: load must be non-negative` })
    }
    if (seg.endMs <= seg.startMs) {
      errors.push({ field: 'schedule', message: `Segment ${i}: end must be after start` })
    }
    if (i > 0 && Math.abs(seg.startMs - sorted[i - 1].endMs) > 1) {
      errors.push({ field: 'schedule', message: `Gap or overlap between segments ${i - 1} and ${i}` })
    }
  }
  return errors
}

// ─── Simulation state (per time step) ──────────────────────────────────────

export type PowerState = {
  tMs: number
  sunUp: boolean
  solarKw: number          // generation this step (0 or maxSolarKw)
  loadKw: number           // consumption this step
  netKw: number            // solar - load (positive = charging)
  chargeKwh: number        // battery charge after this step
  deficitKwh: number       // cumulative unmet energy demand
  reserveBreached: boolean // charge < minReserve at any point up to here
}

// ─── Result ────────────────────────────────────────────────────────────────

export type PowerResult = {
  viable: boolean
  reason: string | null         // null if viable
  totalSolarKwh: number
  totalConsumedKwh: number
  lowestChargeKwh: number
  lowestChargeAtMs: number
  minReserveMarginKwh: number   // lowestCharge - minReserve (negative = breached)
  totalDeficitKwh: number
  timeline: PowerState[]        // one entry per simulation step
  sunIntervals: Interval[]      // the sun-up windows used by the simulation
}


// ─── Simulation engine ─────────────────────────────────────────────────────

const MS_TO_H = 1 / 3_600_000

/** Options for the power simulation. */
export type SimulateOptions = {
  /** Simulation time step in ms. Default 5 minutes. Shorter = more accurate near transitions. */
  dtMs?: number
  /** Time-dependent power schedule. If omitted, config.normalLoadKw is used throughout. */
  schedule?: PowerSchedule
  /** Optional callback for future degradation modelling: (state, config) => adjusted maxCapacityKwh.
   *  Not used in the initial implementation. */
  degradation?: (state: PowerState, config: PowerConfig) => number
}

/** Look up the load at a given mission-relative time from a sorted schedule. */
function loadAt(schedule: PowerSchedule | undefined, normalKw: number, missionMs: number): number {
  if (!schedule || schedule.length === 0) return normalKw
  for (const seg of schedule) {
    if (missionMs >= seg.startMs && missionMs < seg.endMs) return seg.loadKw
  }
  return normalKw
}

/** Is missionMs inside any of the sun-up intervals? Binary search for performance. */
function isSunUp(intervals: Interval[], startMs: number, missionMs: number): boolean {
  const t = startMs + missionMs
  let lo = 0
  let hi = intervals.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (t < intervals[mid].start) hi = mid - 1
    else if (t >= intervals[mid].end) lo = mid + 1
    else return true
  }
  return false
}

/**
 * Run a chronological battery simulation over the entire mission.
 *
 * Uses the pre-computed sun-up intervals from the existing environmental
 * simulation (windows('sun', ...)) rather than calling skyAt at every step.
 * The caller must supply these intervals aligned to the mission window.
 *
 * At each step:
 *   1. Determine solar generation: maxSolarKw if sun is up, else 0.
 *   2. Determine current load from the schedule (or normalLoadKw).
 *   3. Compute net power = solar - load.
 *   4. Update battery: charge += net * dt, clamped to [0, maxCapacity].
 *   5. If charge would go negative, record the deficit.
 *   6. Check the minimum reserve.
 */
export function simulatePower(
  config: PowerConfig,
  sunIntervals: Interval[],
  missionStartMs: number,
  opts: SimulateOptions = {},
): PowerResult {
  const dtMs = opts.dtMs ?? 5 * 60_000
  const schedule = opts.schedule

  let charge = config.initialChargeKwh
  let totalSolar = 0
  let totalConsumed = 0
  let deficit = 0
  let lowestCharge = charge
  let lowestChargeAt = 0
  let reserveBreached = false

  const timeline: PowerState[] = []
  const steps = Math.ceil(config.stayMs / dtMs)

  for (let i = 0; i <= steps; i++) {
    const missionMs = Math.min(i * dtMs, config.stayMs)
    const sunUp = isSunUp(sunIntervals, missionStartMs, missionMs)
    const solarKw = sunUp ? config.maxSolarKw : 0
    const currentLoad = loadAt(schedule, config.normalLoadKw, missionMs)
    const netKw = solarKw - currentLoad

    if (i > 0) {
      const actualDt = Math.min(dtMs, config.stayMs - (i - 1) * dtMs) * MS_TO_H
      const maxCap = opts.degradation
        ? opts.degradation(timeline[timeline.length - 1], config)
        : config.maxCapacityKwh
      const raw = charge + netKw * actualDt

      totalSolar += solarKw * actualDt
      totalConsumed += currentLoad * actualDt

      if (raw < 0) {
        deficit += -raw
        charge = 0
      } else {
        charge = Math.min(raw, maxCap)
      }
    }

    if (charge < lowestCharge) {
      lowestCharge = charge
      lowestChargeAt = missionMs
    }
    if (charge < config.minReserveKwh) {
      reserveBreached = true
    }

    timeline.push({
      tMs: missionStartMs + missionMs,
      sunUp,
      solarKw,
      loadKw: currentLoad,
      netKw,
      chargeKwh: charge,
      deficitKwh: deficit,
      reserveBreached,
    })
  }

  const minMargin = lowestCharge - config.minReserveKwh

  let reason: string | null = null
  if (deficit > 0) reason = 'Battery depleted: unmet energy demand'
  else if (reserveBreached) reason = 'Battery charge fell below minimum reserve'

  return {
    viable: reason === null,
    reason,
    totalSolarKwh: totalSolar,
    totalConsumedKwh: totalConsumed,
    lowestChargeKwh: lowestCharge,
    lowestChargeAtMs: missionStartMs + lowestChargeAt,
    minReserveMarginKwh: minMargin,
    totalDeficitKwh: deficit,
    timeline,
    sunIntervals,
  }
}
