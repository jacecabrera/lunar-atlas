// Device loads, battery and supply over the mission window (v0.7 section 5, step 12).
//
// Window: [landing, landing + stay], starting at landing (no wait for sunrise or deployment).
// Loads:    P_device(t) = baseLoadW + commLoadW * I_E(t)        I_E: Earth geometrically visible (step 09/10)
//           P_bus(t)    = P_device(t) / busEfficiency
// Battery (bus-side net power, internal stored energy in Wh, integration in hours):
//           deltaP = P_PV - P_bus
//           charge     = min(max(deltaP, 0), chargeLimitW, room to capacity)          curtailed = rest of the surplus
//           discharge  = min(max(-deltaP, 0), dischargeLimitW, energy above reserve)  unmet = rest of the demand
//           E += (etaCharge * charge - discharge / etaDischarge) * dtHours
// PV that feeds the load directly never passes through the battery efficiencies. Charging and discharging never
// happen at the same time. The stored energy never goes below the reserve: when demand remains at the reserve (or
// exceeds the discharge limit), the unmet load is recorded and the mission fails at that instant; recharging later does
// not erase the failure. Actual stored energy and the unmet (deficit) ledger are kept apart.
//
// Unknown inputs. PV may be only bounded (unknown visible fraction) and the Earth state may be unknown (communication
// load 0 or commLoadW). Two scenarios are simulated: pessimistic (PV lower bound, load upper bound) and optimistic
// (PV upper bound, load lower bound). The step update is monotone: more PV or less load never lowers the stored energy
// or raises the unmet load at any later time (charge = min(E + etaC c dt, cap) and discharge = max(E - d dt / etaD,
// reserve) are non-decreasing in E and in PV, non-increasing in load). Hence: pessimistic supplies everything -> the
// condition passes; optimistic fails -> it fails (no later than the optimistic failure time); otherwise unknown.
// Short unresolved event intervals (step 10) are treated as unknown in both PV and Earth state.
//
// Numerics: each event segment (constant Earth state, constant Sun state) is cut into equal steps no longer than
// stepMs; PV is evaluated at the step midpoint. An unmet energy below 1e-6 Wh in a step is floating-point residue.
import type { ConditionReason, ConditionResult } from './assessment'
import type { AdvancedSettings, DeviceConfig, MissionWindow } from './mission'
import { reserveEnergyWh, validateAdvancedSettings } from './mission'
import type { Interval } from '../physics/siteTimeline'
import type { VisibilityModel } from './visibility'
import type { EventSearchOptions, EventSearchResult, TriState } from './events'
import { RATE_BOUNDS, searchEvents } from './events'
import { pvPowerAt } from './pv'
import type { PvSample } from './pv'

export const ENERGY_MODEL = 'energy-v2:loads=base+comm*I_E;bus-eff;battery=charge/discharge-eff,limits,reserve;midpoint<=5min+half-step-check;pv-rate-bound;bounds=pessimistic/optimistic'

export type EnergyStep = {
  startMs: number; endMs: number
  pvW: number; loadDeviceW: number; loadBusW: number
  /** PV used directly by the load, W (no battery losses). */
  directW: number
  chargeBusW: number; dischargeBusW: number; curtailedW: number
  /** Bus power that could not be supplied, W (requiredDischarge - actual discharge). */
  unmetBusW: number
  /** Stored energy at the end of the step, Wh (never below the reserve). */
  energyWh: number
  /** Part of the step during which the specified load was fully supplied, ms. */
  suppliedMs: number
}

export type FailureCause = 'reserve' | 'discharge-limit'

export type EnergyScenario = {
  name: 'pessimistic' | 'optimistic'
  steps: EnergyStep[]
  /** First instant at which the specified load could not be supplied. */
  firstFailure: { tMs: number; cause: FailureCause } | null
  minEnergyWh: number
  minEnergyMs: number
  endEnergyWh: number
  /** Times when the specified load was fully supplied (after a failure, supply may resume). */
  suppliedIntervals: Interval[]
  totals: {
    pvWh: number; loadBusWh: number; directWh: number; chargedBusWh: number; storedWh: number; chargeLossWh: number
    dischargedBusWh: number; drawnWh: number; dischargeLossWh: number; curtailedWh: number; unmetWh: number
  }
}

export type EnergyResult = {
  window: { startMs: number; endMs: number }
  /** The power condition (SiteConditions.power). */
  condition: ConditionResult
  /** determined: no unknown input; bounded: unknown inputs bounded by the two scenarios; error: computation failed. */
  status: 'determined' | 'bounded' | 'error'
  pessimistic: EnergyScenario | null
  optimistic: EnergyScenario | null
  /** For the communication check: supply proven (pessimistic) and possible (optimistic). */
  supply: { proven: Interval[]; possible: Interval[] }
  /** Earth geometric visibility: proven visible, and visible or unknown. */
  earth: { visible: Interval[]; possible: Interval[]; search: EventSearchResult | null }
  sunSearch: EventSearchResult | null
  /** Time with unknown PV input, unknown Earth state, and unresolved event intervals, ms. */
  unknown: { pvMs: number; earthMs: number; unresolvedMs: number }
  reserveWh: number
  stepMs: number
  model: string
}

/** Inputs per step, as bounds. lower = upper where the input is known. */
export type StepInput = { startMs: number; endMs: number; pvLowerW: number; pvUpperW: number; commOnLower: boolean; commOnUpper: boolean }

// Unmet energy below this per step is floating-point residue: ~1e4 Wh accumulated over ~1e4 steps leaves errors of
// order 1e-8 Wh. Same scale as the reserve-margin rounding in assessEnergy. Not a physical allowance.
const EPS_WH = 1e-6

/** Battery simulation for one scenario (pure; exposed for tests and the analytic checks). */
export function simulateBattery(
  device: DeviceConfig, inputs: Array<{ startMs: number; endMs: number; pvW: number; commOn: boolean }>, name: EnergyScenario['name'] = 'pessimistic',
): EnergyScenario {
  const R = reserveEnergyWh(device)
  const cap = device.batteryCapacityWh
  let E = device.initialEnergyWh
  let minE = E, minMs = inputs[0]?.startMs ?? 0
  let firstFailure: EnergyScenario['firstFailure'] = null
  const steps: EnergyStep[] = []
  const supplied: Interval[] = []
  const t = { pvWh: 0, loadBusWh: 0, directWh: 0, chargedBusWh: 0, storedWh: 0, chargeLossWh: 0, dischargedBusWh: 0, drawnWh: 0, dischargeLossWh: 0, curtailedWh: 0, unmetWh: 0 }
  const addSupplied = (a: number, b: number) => {
    if (b <= a) return
    const last = supplied[supplied.length - 1]
    if (last && Math.abs(last.end - a) < 1e-6) last.end = b
    else supplied.push({ start: a, end: b })
  }
  for (const s of inputs) {
    const dtMs = s.endMs - s.startMs
    if (!(dtMs > 0)) continue
    const dtH = dtMs / 3_600_000
    const loadDeviceW = device.baseLoadW + (s.commOn ? device.commLoadW : 0)
    const loadBusW = loadDeviceW / device.busEfficiency
    const dP = s.pvW - loadBusW
    let charge = 0, discharge = 0, curtailed = 0, unmet = 0, suppliedMs = dtMs
    if (dP >= 0) {
      const room = Math.max(0, (cap - E) / (device.chargeEfficiency * dtH))
      charge = Math.min(dP, device.chargeLimitW, room)
      curtailed = dP - charge
      E = charge === room ? cap : Math.min(cap, E + device.chargeEfficiency * charge * dtH)
    } else {
      const req = -dP
      const E0 = E
      const availRate = Math.max(0, E0 - R) * device.dischargeEfficiency / dtH
      discharge = Math.min(req, device.dischargeLimitW, availRate)
      unmet = req - discharge
      E = discharge === availRate ? R : Math.max(R, E0 - (discharge / device.dischargeEfficiency) * dtH)
      if (unmet * dtH > EPS_WH) {
        let failAt: number, cause: FailureCause
        if (req > device.dischargeLimitW) { failAt = s.startMs; cause = 'discharge-limit'; suppliedMs = 0 }
        else {
          // The reserve is reached part-way through the step at the current demand.
          const tau = (Math.max(0, E0 - R) * device.dischargeEfficiency / req) * 3_600_000
          failAt = s.startMs + Math.min(dtMs, tau); cause = 'reserve'; suppliedMs = Math.min(dtMs, tau)
        }
        if (!firstFailure) firstFailure = { tMs: failAt, cause }
      } else unmet = 0
    }
    addSupplied(s.startMs, s.startMs + suppliedMs)
    const directW = Math.min(s.pvW, loadBusW)
    steps.push({ startMs: s.startMs, endMs: s.endMs, pvW: s.pvW, loadDeviceW, loadBusW, directW, chargeBusW: charge, dischargeBusW: discharge, curtailedW: curtailed, unmetBusW: unmet, energyWh: E, suppliedMs })
    t.pvWh += s.pvW * dtH; t.loadBusWh += loadBusW * dtH; t.directWh += directW * dtH
    t.chargedBusWh += charge * dtH; t.storedWh += device.chargeEfficiency * charge * dtH
    t.dischargedBusWh += discharge * dtH; t.drawnWh += (discharge / device.dischargeEfficiency) * dtH
    t.curtailedWh += curtailed * dtH; t.unmetWh += unmet * dtH
    if (E < minE) { minE = E; minMs = s.endMs }
  }
  t.chargeLossWh = t.chargedBusWh - t.storedWh
  t.dischargeLossWh = t.drawnWh - t.dischargedBusWh
  return { name, steps, firstFailure, minEnergyWh: minE, minEnergyMs: minMs, endEnergyWh: E, suppliedIntervals: supplied, totals: t }
}

const total = (iv: Interval[]) => iv.reduce((s, i) => s + i.end - i.start, 0)

/** State of a search result at t: null inside unknown segments, unresolved intervals or unsearched time. */
function stateAt(r: EventSearchResult, t: number): TriState {
  if (t >= r.searchedToMs) return null
  if (r.unresolved.some((u) => u.start <= t && t < u.end)) return null
  const seg = r.segments.find((s) => s.start <= t && t < s.end) ?? r.segments[r.segments.length - 1]
  return seg ? seg.state : null
}

export type EnergyOptions = { stepMs?: number; events?: EventSearchOptions }

/**
 * Upper bound on |dP_PV/dt| (W/h) near a PV sample, from the sky-rate bounds of events.ts (ASM-PV-RATE-BOUND):
 *   P = k sum_j A_j f cos_j,  k = S eta k_loss (its distance term changes < 1e-4 per day and is neglected).
 *   |d cos_j/dt| <= omega_sun (rad/h) for a unit vector moving at omega_sun.
 *   |df/dt| <= 2 v_t / (pi rho) + (omega_sun + omega_earth) / rho, where v_t = omega_sun (1 + S (1 + rho tan el) / cos el)
 *   is the fastest vertical motion of the skyline across the disc (the visible area changes at most by the chord length
 *   2 rho times v_t) and the Earth's edge sweeps at most an arc of pi rho at the relative rate.
 * The controller limit min(P, limit) does not increase the rate.
 */
export function pvRateBoundWPerHour(p: PvSample, areaM2: number, efficiency: number, lossFactor: number, skylineSlope: number, halfStepMs: number): number {
  const deg = Math.PI / 180
  const k = (p.irradianceWm2 ?? 0) * efficiency * lossFactor
  const rho = Math.asin(695_700 / (p.sunDistanceKm ?? 1.5e8)) / deg
  const w = RATE_BOUNDS.sunDegPerHour, we = RATE_BOUNDS.earthDegPerHour
  const elMax = Math.min(89.9, Math.abs(p.sunElevationDeg ?? 0) + (w * halfStepMs) / 3_600_000)
  const vt = w * (1 + (skylineSlope * (1 + rho * deg * Math.tan(elMax * deg))) / Math.cos(elMax * deg))
  const dfdt = (2 * vt) / (Math.PI * rho) + (w + we) / rho
  return k * areaM2 * (w * deg + dfdt)
}

type Built = { inputs: StepInput[]; unknown: { pvMs: number; earthMs: number; unresolvedMs: number }; dischargeRisk: Interval[] } | { error: ConditionReason[] }

function buildInputs(model: VisibilityModel, settings: AdvancedSettings, window: MissionWindow, earth: EventSearchResult, sun: EventSearchResult, stepMs: number): Built {
  const cuts = new Set<number>([window.startMs, window.endMs, earth.searchedToMs, sun.searchedToMs])
  for (const r of [earth, sun]) {
    for (const x of r.segments) { cuts.add(x.start); cuts.add(x.end) }
    for (const u of r.unresolved) { cuts.add(u.start); cuts.add(u.end) }
  }
  const points = [...cuts].filter((x) => x >= window.startMs && x <= window.endMs).sort((a, b) => a - b)
  const inputs: StepInput[] = []
  const dischargeRisk: Interval[] = []
  const unknown = { pvMs: 0, earthMs: 0, unresolvedMs: total(earth.unresolved) + total(sun.unresolved) }
  const d = settings.device
  const pvSettings = { device: d, model: settings.model }
  const area = d.panels.reduce((x, q) => x + q.areaM2, 0)
  const maxBusW = (d.baseLoadW + d.commLoadW) / d.busEfficiency
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1]
    if (b - a <= 0) continue
    const n = Math.max(1, Math.ceil((b - a) / stepMs))
    const mid0 = (a + b) / 2
    const eState = stateAt(earth, mid0)
    const sunUnresolved = sun.unresolved.some((u) => u.start <= mid0 && mid0 < u.end) || mid0 >= sun.searchedToMs
    for (let k = 0; k < n; k++) {
      const s0 = a + ((b - a) * k) / n, s1 = a + ((b - a) * (k + 1)) / n
      const p = pvPowerAt(model, pvSettings, (s0 + s1) / 2)
      if (p.status === 'error') return { error: p.reasons }
      let lo = p.lowerW!, up = p.upperW!
      if (sunUnresolved) { lo = 0; up = Math.min(d.pvOutputLimitW, p.panels.reduce((x, q) => x + q.rawUpperW, 0)) }
      if (up > lo) unknown.pvMs += s1 - s0
      if (eState === null) unknown.earthMs += s1 - s0
      // A demand above the discharge limit between samples is excluded only if the PV rate bound proves it.
      if (maxBusW > d.dischargeLimitW) {
        const busW = (d.baseLoadW + (eState !== false ? d.commLoadW : 0)) / d.busEfficiency
        const minPv = up > lo ? lo : Math.max(0, lo - pvRateBoundWPerHour(p, area, d.pvEfficiency, settings.model.lossFactor, model.skylineMaxSlope ?? 0, (s1 - s0) / 2) * ((s1 - s0) / 2 / 3_600_000))
        if (busW - minPv > d.dischargeLimitW && busW - lo <= d.dischargeLimitW) dischargeRisk.push({ start: s0, end: s1 })
      }
      inputs.push({ startMs: s0, endMs: s1, pvLowerW: lo, pvUpperW: up, commOnLower: eState === true, commOnUpper: eState !== false })
    }
  }
  return { inputs, unknown, dischargeRisk }
}

const run = (d: DeviceConfig, inputs: StepInput[], name: EnergyScenario['name']) => simulateBattery(d, inputs.map((x) => ({
  startMs: x.startMs, endMs: x.endMs, pvW: name === 'pessimistic' ? x.pvLowerW : x.pvUpperW, commOn: name === 'pessimistic' ? x.commOnUpper : x.commOnLower,
})), name)

/**
 * Formal energy assessment over the mission window.
 * Numerical safeguards (ASM-ENERGY-STEP): the simulation is repeated with half the step. pass needs the pessimistic case
 * to supply everything at both resolutions with a reserve margin of at least twice the change of its minimum energy,
 * and no step where the PV rate bound leaves a discharge-limit violation between samples possible; fail needs the
 * optimistic case to fail at both resolutions. Otherwise the result stays unknown ('energy-numerically-unresolved',
 * 'energy-discharge-limit-unproven'). The two-resolution check is a numerical criterion, not a proof of the quadrature.
 */
export function assessEnergy(model: VisibilityModel, settings: AdvancedSettings, window: MissionWindow, opts: EnergyOptions = {}): EnergyResult {
  const stepMs = opts.stepMs ?? 5 * 60_000
  const empty = { startMs: window.startMs, endMs: window.endMs }
  const base = { window: empty, reserveWh: reserveEnergyWh(settings.device), stepMs, model: ENERGY_MODEL }
  const errorResult = (reasons: ConditionReason[]): EnergyResult => ({
    ...base, condition: { status: 'error', reasons }, status: 'error', pessimistic: null, optimistic: null,
    supply: { proven: [], possible: [] }, earth: { visible: [], possible: [], search: null }, sunSearch: null, unknown: { pvMs: 0, earthMs: 0, unresolvedMs: 0 },
  })
  const invalid = validateAdvancedSettings(settings)
  if (!(window.endMs > window.startMs) || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) invalid.push('Mission window must be finite with end after start')
  if (!(stepMs > 0)) invalid.push('Energy step must be positive')
  if (invalid.length) return errorResult(invalid.map((m) => ({ code: 'invalid-input', message: m })))

  let earth: EventSearchResult, sun: EventSearchResult
  try {
    earth = searchEvents(model, 'earth', window.startMs, window.endMs, opts.events)
    sun = searchEvents(model, 'sun', window.startMs, window.endMs, opts.events)
  } catch (e) {
    return errorResult([{ code: 'visibility-computation-error', message: e instanceof Error ? e.message : String(e) }])
  }
  const coarse = buildInputs(model, settings, window, earth, sun, stepMs)
  if ('error' in coarse) return errorResult(coarse.error)
  const fine = buildInputs(model, settings, window, earth, sun, stepMs / 2)
  if ('error' in fine) return errorResult(fine.error)
  const { unknown } = coarse
  const d = settings.device
  const determined = unknown.pvMs === 0 && unknown.earthMs === 0
  const pess = run(d, coarse.inputs, 'pessimistic'), pessFine = run(d, fine.inputs, 'pessimistic')
  const opt = determined ? { ...pess, name: 'optimistic' as const } : run(d, coarse.inputs, 'optimistic')
  const optFine = determined ? { ...pessFine, name: 'optimistic' as const } : run(d, fine.inputs, 'optimistic')
  const risk = [...coarse.dischargeRisk, ...fine.dischargeRisk]

  const earthVisible = earth.segments.filter((x) => x.state === true).map((x) => ({ start: x.start, end: x.end }))
  const earthPossible = earth.segments.filter((x) => x.state !== false).map((x) => ({ start: x.start, end: x.end }))
  if (earth.searchedToMs < window.endMs) earthPossible.push({ start: earth.searchedToMs, end: window.endMs })
  for (const u of earth.unresolved) earthPossible.push({ ...u })
  earthPossible.sort((x, y) => x.start - y.start)

  const limitations = [
    'Current model only: thermal control, temperature-dependent battery behaviour, ageing and dust are not modelled.',
    'Communication load follows geometric Earth visibility; no link budget is implied.',
    `Numerical integration with ${stepMs / 60_000} min steps, checked against half the step.`,
  ]
  const R = base.reserveWh
  const minChange = Math.abs(pess.minEnergyWh - pessFine.minEnergyWh)
  const margin = Math.min(pess.minEnergyWh, pessFine.minEnergyWh) - R
  // 1e-6 Wh absorbs floating-point rounding only (energies are ~1e4 Wh); it is not a physical allowance.
  const ROUND_WH = EPS_WH
  const passProven = !pess.firstFailure && !pessFine.firstFailure && margin + ROUND_WH >= 2 * minChange && risk.length === 0
  const failProven = !!opt.firstFailure && !!optFine.firstFailure
  let condition: ConditionResult
  const fmt = (ms: number) => new Date(ms).toISOString()
  if (passProven) {
    condition = {
      status: 'pass', reasons: [],
      values: { minEnergyWh: { value: pess.minEnergyWh, unit: 'Wh' }, reserveWh: { value: R, unit: 'Wh' }, minEnergyChangeHalfStepWh: { value: minChange, unit: 'Wh' } },
      limitations: determined ? limitations : [...limitations, 'Proven with the lower PV bound and the upper load bound for the unknown parts.'],
    }
  } else if (failProven) {
    const f = opt.firstFailure!
    condition = {
      status: 'fail',
      reasons: [{ code: f.cause === 'reserve' ? 'energy-reserve-reached' : 'energy-discharge-limit-exceeded', message: determined
        ? `The load cannot be supplied from ${fmt(f.tMs)} (${f.cause === 'reserve' ? 'stored energy at the reserve with net demand remaining' : 'net demand above the discharge limit'})`
        : `The load cannot be supplied from ${fmt(f.tMs)} at the latest, even with the upper PV bound and the lower load bound` }],
      values: { firstFailureMs: { value: f.tMs, unit: 'ms' }, firstFailureHalfStepMs: { value: optFine.firstFailure!.tMs, unit: 'ms' }, minEnergyWh: { value: opt.minEnergyWh, unit: 'Wh' } },
      limitations,
    }
  } else {
    const reasons: ConditionReason[] = []
    if (unknown.pvMs > 0) reasons.push({ code: 'energy-pv-unknown', message: `PV output is only bounded for ${Math.round(unknown.pvMs / 60_000)} min` })
    if (unknown.earthMs > 0) reasons.push({ code: 'energy-comm-load-unknown', message: `The Earth state (communication load) is unknown for ${Math.round(unknown.earthMs / 60_000)} min` })
    if (unknown.unresolvedMs > 0) reasons.push({ code: 'energy-unresolved-events', message: `${Math.round(unknown.unresolvedMs / 1000)} s of unresolved event intervals` })
    if (risk.length) reasons.push({ code: 'energy-discharge-limit-unproven', message: `A demand above the discharge limit between samples cannot be excluded in ${risk.length} steps` })
    if (!pess.firstFailure !== !pessFine.firstFailure || !opt.firstFailure !== !optFine.firstFailure || (!pess.firstFailure && margin + ROUND_WH < 2 * minChange)) {
      reasons.push({ code: 'energy-numerically-unresolved', message: `The result changes with the integration step (minimum energy ${pess.minEnergyWh.toFixed(3)} vs ${pessFine.minEnergyWh.toFixed(3)} Wh, reserve ${R} Wh)` })
    }
    if (pess.firstFailure && !opt.firstFailure) reasons.push({ code: 'energy-undetermined', message: `Supply fails in the pessimistic case at ${fmt(pess.firstFailure.tMs)} but not in the optimistic case` })
    reasons.push(...model.reasons)
    condition = { status: 'unknown', reasons, limitations }
  }
  return {
    ...base, condition, status: determined ? 'determined' : 'bounded', pessimistic: pess, optimistic: opt,
    supply: { proven: pess.suppliedIntervals, possible: opt.suppliedIntervals },
    earth: { visible: earthVisible, possible: earthPossible, search: earth }, sunSearch: sun, unknown,
  }
}
