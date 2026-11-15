// Energy tests. SYNTHETIC visibility (testing/fakeVisibility) unless the real model is named.
import { describe, expect, it } from 'vitest'
import { assessEnergy, simulateBattery } from './energy'
import { pvFromSun } from './pv'
import { defaultAdvancedSettings } from './defaults'
import type { AdvancedSettings } from './mission'
import { fakeVisibility, ramp, H } from './testing/fakeVisibility'
import { visibilityModel } from './visibility'
import type { HorizonData } from './horizonData'

const T0 = Date.UTC(2027, 0, 1)
const base = defaultAdvancedSettings()
const withDevice = (d: Partial<AdvancedSettings['device']>): AdvancedSettings => ({ ...base, device: { ...base.device, ...d } })
const dark = (earth: number) => fakeVisibility({ sunMargin: () => -0.05, earthMargin: () => earth })
const sunny = (earth: number) => fakeVisibility({ sunMargin: () => 0.05, earthMargin: () => earth })
// Independent analytic time to reserve with no sunlight and a constant load.
const toReserveH = (deviceW: number, s = base.device) => ((s.initialEnergyWh - s.batteryCapacityWh * s.reserveFraction) * s.dischargeEfficiency) / (deviceW / s.busEfficiency)

describe('no sunlight: analytic time to the reserve', () => {
  it('base load only: about 356.9 h', () => {
    const h = toReserveH(23)
    expect(h).toBeCloseTo(356.87, 2)
    const r = assessEnergy(dark(-0.05), base, { startMs: T0, endMs: T0 + 400 * H })
    expect(r.condition.status).toBe('fail')
    expect(r.pessimistic!.firstFailure!.cause).toBe('reserve')
    expect(Math.abs(r.pessimistic!.firstFailure!.tMs - (T0 + h * H))).toBeLessThan(1000)
    expect(r.pessimistic!.minEnergyWh).toBeCloseTo(2400, 6) // stored energy never below the reserve
  })
  it('base plus communication: about 293.1 h', () => {
    const h = toReserveH(28)
    expect(h).toBeCloseTo(293.14, 2)
    const r = assessEnergy(dark(0.05), base, { startMs: T0, endMs: T0 + 400 * H })
    expect(Math.abs(r.pessimistic!.firstFailure!.tMs - (T0 + h * H))).toBeLessThan(1000)
  })
  it('reaching the reserve exactly at the end is not a failure; a little later is', () => {
    const h = toReserveH(23)
    expect(assessEnergy(dark(-0.05), base, { startMs: T0, endMs: T0 + h * H }).condition.status).toBe('pass')
    expect(assessEnergy(dark(-0.05), base, { startMs: T0, endMs: T0 + h * H + 60_000 }).condition.status).toBe('fail')
  })
})

describe('efficiencies, limits and curtailment', () => {
  it('charge and discharge efficiencies act separately, PV to the load directly has no battery loss', () => {
    const s = withDevice({ initialEnergyWh: 6000 })
    const r = assessEnergy(sunny(-0.05), s, { startMs: T0, endMs: T0 + 10 * H })
    const surplus = 100 - 23 / 0.9 // PV capped at 100 W
    expect(r.pessimistic!.endEnergyWh).toBeCloseTo(6000 + 0.95 * surplus * 10, 6)
    expect(r.pessimistic!.totals.directWh).toBeCloseTo((23 / 0.9) * 10, 6)
    expect(r.pessimistic!.totals.chargeLossWh).toBeCloseTo(0.05 * surplus * 10, 6)
    const d = assessEnergy(dark(-0.05), withDevice({ dischargeEfficiency: 0.8 }), { startMs: T0, endMs: T0 + 10 * H })
    expect(d.pessimistic!.endEnergyWh).toBeCloseTo(12000 - ((23 / 0.9) / 0.8) * 10, 6)
  })
  it('net demand above the discharge limit fails although energy remains', () => {
    const r = assessEnergy(dark(-0.05), withDevice({ baseLoadW: 95 }), { startMs: T0, endMs: T0 + H }) // 105.6 W at the bus
    expect(r.condition.status).toBe('fail')
    expect(r.pessimistic!.firstFailure).toEqual({ tMs: T0, cause: 'discharge-limit' })
    expect(r.pessimistic!.endEnergyWh).toBeGreaterThan(11_000)
    expect(r.pessimistic!.steps[0].unmetBusW).toBeCloseTo(95 / 0.9 - 100, 9) // required minus supplied
  })
  it('records curtailment when full and when the charge limit binds', () => {
    const full = assessEnergy(sunny(-0.05), base, { startMs: T0, endMs: T0 + H })
    expect(full.pessimistic!.totals.curtailedWh).toBeCloseTo(100 - 23 / 0.9, 6)
    const limited = assessEnergy(sunny(-0.05), withDevice({ initialEnergyWh: 6000, chargeLimitW: 50 }), { startMs: T0, endMs: T0 + H })
    expect(limited.pessimistic!.steps[0].chargeBusW).toBe(50)
    expect(limited.pessimistic!.totals.curtailedWh).toBeCloseTo(100 - 23 / 0.9 - 50, 6)
  })
})

describe('failure, recovery, switching and steps', () => {
  it('keeps an earlier failure after recharging, and supply resumes', () => {
    const h = toReserveH(23)
    const m = fakeVisibility({ sunMargin: ramp(T0 + (h + 20) * H, 1, 0.5), earthMargin: () => -0.05 })
    const r = assessEnergy(m, base, { startMs: T0, endMs: T0 + (h + 60) * H })
    expect(r.condition.status).toBe('fail')
    expect(Math.abs(r.pessimistic!.firstFailure!.tMs - (T0 + h * H))).toBeLessThan(1000)
    const later = r.supply.proven.filter((i) => i.start > T0 + (h + 1) * H)
    expect(later.length).toBe(1)
    expect(Math.abs(later[0].start - (T0 + (h + 20) * H))).toBeLessThan(2000) // supplied again from sunrise
    expect(r.pessimistic!.endEnergyWh).toBeGreaterThan(2400)
  })
  it('switches the communication load at the Earth event and handles a final partial step', () => {
    const tSwitch = T0 + 7.3 * H
    const end = T0 + 20 * H + 123_000 // not a multiple of the step
    const m = fakeVisibility({ sunMargin: () => -0.05, earthMargin: ramp(tSwitch, 1, 0.14) })
    const r = assessEnergy(m, base, { startMs: T0, endMs: end })
    const expected = 12000 - ((23 * 7.3 + 28 * ((end - tSwitch) / H)) / 0.9) / 0.95
    expect(r.pessimistic!.endEnergyWh).toBeCloseTo(expected, 1)
    expect(r.pessimistic!.steps.at(-1)!.endMs).toBe(end)
  })
  it('closes the energy balance and converges with the step size (real ephemeris, synthetic flat horizon)', () => {
    const az = Array.from({ length: 720 }, (_, i) => i * 0.5)
    const hz: HorizonData = {
      status: 'available', site: { lat: 20, lon: 30 }, samples: { elevationsDeg: az.map(() => 0.5), startAzimuthDeg: 0, stepDeg: 0.5, angleUnit: 'deg' },
      source: { product: 's', gridSpacingKm: 0.002, verticalAccuracyM: null, referenceRadiusKm: 1737.4, frame: 's' }, model: { maxRangeKm: 200, mastM: 0, rayStepKm: 0.001, observerElevationM: 0 },
      observer: { elevationM: 0, elevationSource: 's', elevationQuality: 'measured', observerHeightM: 0, radiusKm: 1737.4 },
      coverage: { searchRangeKm: 200, nearStartKm: 0.02, complete: true, nearField: 'screened', sampleStatus: az.map(() => 'complete'), coveredToKm: az.map(() => 200), governingKm: az.map(() => 1), governingSource: az.map(() => 's'), uncertaintyDeg: az.map(() => null), fallbackSamples: 0, skippedSamples: 0, lowerBoundAzimuths: 0 },
      quality: { nearFieldSelection: { productId: 's', tier: 'all gates', degraded: false }, convergence: { status: 'within-tolerance', toleranceDeg: 0.05, checks: [] } },
    }
    const m = visibilityModel({ lat: 20, lon: 30, horizon: hz }, { earthMinElevationDeg: 0 })
    const w = { startMs: Date.UTC(2027, 0, 10), endMs: Date.UTC(2027, 1, 9) }
    const runs = [20, 5, 1].map((min) => assessEnergy(m, base, w, { stepMs: min * 60_000 }))
    for (const r of runs) {
      const t = r.pessimistic!.totals
      // Only the short unresolved intervals next to events (<= 10 s each) are unknown here.
      expect(r.unknown.pvMs).toBeLessThanOrEqual(r.unknown.unresolvedMs + 1)
      expect(r.unknown.earthMs).toBeLessThanOrEqual(r.unknown.unresolvedMs + 1)
      expect(r.pessimistic!.endEnergyWh - 12000).toBeCloseTo(t.storedWh - t.drawnWh, 6)
      expect(t.pvWh).toBeCloseTo(t.directWh + t.chargedBusWh + t.curtailedWh, 6)
      expect(t.loadBusWh).toBeCloseTo(t.directWh + t.dischargedBusWh + t.unmetWh, 6)
    }
    const [a, b, c] = runs.map((r) => r.pessimistic!)
    expect(Math.abs(a.minEnergyWh - c.minEnergyWh)).toBeLessThan(1)
    // Final status, first failure (the lunar night at this site), and short shortfalls agree across steps.
    expect(runs.map((r) => r.condition.status)).toEqual(['fail', 'fail', 'fail'])
    expect(Math.abs(a.firstFailure!.tMs - c.firstFailure!.tMs)).toBeLessThan(20 * 60_000)
    expect(Math.abs(b.firstFailure!.tMs - c.firstFailure!.tMs)).toBeLessThan(5 * 60_000)
    expect(Math.abs(a.totals.unmetWh - c.totals.unmetWh) / c.totals.unmetWh).toBeLessThan(1e-2)
    expect(Math.abs(b.totals.pvWh - c.totals.pvWh) / c.totals.pvWh).toBeLessThan(1e-4)
    // Not binary: vertical east/west panels see the Sun obliquely, so the energy is well below 100 W x sunlit time.
    const sunlitH = (runs[2].sunSearch!.segments.filter((s) => s.state === true).reduce((x, s) => x + s.end - s.start, 0)) / H
    expect(c.totals.pvWh).toBeLessThan(100 * sunlitH * 0.9)
  })
})

describe('numerical boundaries', () => {
  it('1 s around the reserve time: pass before, fail after', () => {
    const h = toReserveH(23)
    expect(assessEnergy(dark(-0.05), base, { startMs: T0, endMs: T0 + h * H - 1000 }).condition.status).toBe('pass')
    expect(assessEnergy(dark(-0.05), base, { startMs: T0, endMs: T0 + h * H + 1000 }).condition.status).toBe('fail')
  })
  // Bus load 150 W > 100 W discharge limit: the demand stays below the limit only while PV > 50 W.
  const heavy = withDevice({ baseLoadW: 135 })
  const clear = pvFromSun({ tMs: 0, geometry: { azimuthDeg: 90, elevationDeg: 0, angularRadiusDeg: 0.2666, distanceKm: 149_597_870.7 }, formal: true, terrainVisible: true, terrainVisibleFraction: 1, earthOccultedFraction: 0, visibleFraction: 1, visibleFractionUpperBound: null, sunlit: true, blockedBy: [], terrainMarginDeg: 1, terrainClearanceDeg: 1, earthSeparationDeg: 90, reasons: [] }, { device: base.device, model: base.model }).rawW!
  // A visible-fraction dip centred between samples, changing at 6 per hour (within the PV rate bound of the model).
  const dip = (fMin: number) => (t: number) => Math.min(1, fMin + 6 * Math.abs(t - (T0 + 10 * 60_000)) / H)
  it('a short demand above the discharge limit between samples is not passed: unknown', () => {
    const m = fakeVisibility({ sunMargin: () => 0.05, fraction: dip(0.3), earthMargin: () => -0.05 })
    const r = assessEnergy(m, heavy, { startMs: T0, endMs: T0 + H })
    expect(clear * 0.3).toBeLessThan(150 - 100) // the dip really exceeds the limit at its centre
    expect(r.pessimistic!.firstFailure).toBeNull() // the samples miss it
    expect(r.condition.status).toBe('unknown')
    expect(r.condition.reasons.map((x) => x.code)).toContain('energy-discharge-limit-unproven')
  })
  it('a wider dip that reaches the samples is a proven failure', () => {
    const r = assessEnergy(fakeVisibility({ sunMargin: () => 0.05, fraction: dip(0), earthMargin: () => -0.05 }), heavy, { startMs: T0, endMs: T0 + H })
    expect(r.condition.status).toBe('fail')
    expect(r.condition.reasons[0].code).toBe('energy-discharge-limit-exceeded')
  })
  it('the battery update is monotone in PV and load (property check behind the two scenarios)', () => {
    let seed = 7
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    for (let trial = 0; trial < 50; trial++) {
      const steps = Array.from({ length: 200 }, (_, i) => ({ startMs: i * 600_000, endMs: (i + 1) * 600_000, pvW: rnd() * 120, commOn: rnd() < 0.5 }))
      const more = steps.map((x) => ({ ...x, pvW: x.pvW + rnd() * 30, commOn: x.commOn && rnd() < 0.7 }))
      const dev = { ...base.device, initialEnergyWh: 2400 + rnd() * 9600 }
      const a = simulateBattery(dev, steps), b = simulateBattery(dev, more)
      a.steps.forEach((x, i) => {
        expect(b.steps[i].energyWh).toBeGreaterThanOrEqual(x.energyWh - 1e-9)
        expect(b.steps[i].unmetBusW).toBeLessThanOrEqual(x.unmetBusW + 1e-9)
      })
    }
  })
})

describe('unknown inputs are bounded, not guessed', () => {
  it('unknown PV: short mission passes on the battery alone, long mission stays unknown', () => {
    const m = fakeVisibility({ sunMargin: () => null, earthMargin: () => -0.05 })
    const short = assessEnergy(m, base, { startMs: T0, endMs: T0 + 48 * H })
    expect(short.status).toBe('bounded')
    expect(short.condition.status).toBe('pass')
    expect(short.condition.limitations!.join(' ')).toMatch(/lower PV bound/)
    const long = assessEnergy(m, base, { startMs: T0, endMs: T0 + 30 * 24 * H })
    expect(long.condition.status).toBe('unknown')
    expect(long.condition.reasons.map((x) => x.code)).toContain('energy-pv-unknown')
  })
  it('unknown Earth state: the communication load is bounded (0 or 5 W), never dropped', () => {
    const m = fakeVisibility({ sunMargin: () => -0.05, earthMargin: () => null })
    const r = assessEnergy(m, base, { startMs: T0, endMs: T0 + 300 * H }) // between 293.1 h and 356.9 h
    expect(r.condition.status).toBe('unknown')
    expect(r.condition.reasons.map((x) => x.code)).toContain('energy-comm-load-unknown')
    expect(r.pessimistic!.firstFailure).not.toBeNull()
    expect(r.optimistic!.firstFailure).toBeNull()
  })
  it('a proven failure needs the optimistic case to fail too', () => {
    const m = fakeVisibility({ sunMargin: () => -0.05, earthMargin: () => null })
    const r = assessEnergy(m, base, { startMs: T0, endMs: T0 + 380 * H }) // beyond 356.9 h even without communication
    expect(r.condition.status).toBe('fail')
    expect(r.condition.reasons[0].message).toMatch(/at the latest/)
  })
  it('invalid settings and windows give error, not fail', () => {
    expect(assessEnergy(dark(-0.05), withDevice({ busEfficiency: 0 }), { startMs: T0, endMs: T0 + H }).condition.status).toBe('error')
    expect(assessEnergy(dark(-0.05), base, { startMs: T0, endMs: T0 }).condition.status).toBe('error')
    const broken = { ...dark(-0.05), sunAt: () => { throw new Error('ephemeris failure') } }
    expect(assessEnergy(broken, base, { startMs: T0, endMs: T0 + H }).condition.status).toBe('error')
  })
  it('simulateBattery never stores below the reserve and keeps the deficit separately', () => {
    const r = simulateBattery(base.device, [{ startMs: 0, endMs: 400 * H, pvW: 0, commOn: false }])
    expect(r.endEnergyWh).toBeCloseTo(2400, 6)
    expect(r.totals.unmetWh).toBeGreaterThan(0)
  })
})
