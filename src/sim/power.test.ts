import { describe, expect, it } from 'vitest'
import {
  validateConfig, validateSchedule, simulatePower, assessViability, legacyPowerConfigFromKw,
  LEGACY_PLACEHOLDER_POWER_CONFIG,
} from './power'
import type { LegacyPowerConfigKw } from './power'
import { validateMissionWindow } from './mission'
import { kwToW, whToKwh } from './units'
import type { Interval } from '../physics/siteTimeline'

// ─── helpers ───────────────────────────────────────────────────────────────
// The scenarios keep their original kW/kWh numbers and go through the explicit kW -> W adapter, so every
// assertion below checks the same physical quantity as before the step 03 unit migration.
// These tests describe the LEGACY binary model; the binary assertions are rewritten with the model in step 11.

const HOUR = 3_600_000
const hours = (h: number) => h * HOUR
const START = Date.UTC(2026, 10, 13)
const kWh = whToKwh

/** Build sun intervals: list of [startH, endH] in hours from mission start */
const sunIv = (start: number, pairs: [number, number][]): Interval[] =>
  pairs.map(([a, b]) => ({ start: start + hours(a), end: start + hours(b) }))

/** Mission window of h hours starting at `start` (absolute UTC ms). */
const win = (h: number, start = START) => ({ startMs: start, endMs: start + hours(h) })

const BASE_KW: LegacyPowerConfigKw = {
  normalLoadKw: 2,
  essentialLoadKw: 0.5,
  initialChargeKwh: 50,
  maxCapacityKwh: 100,
  maxSolarKw: 4,
  minReserveKwh: 10,
}
const config = (patch: Partial<LegacyPowerConfigKw> = {}) => legacyPowerConfigFromKw({ ...BASE_KW, ...patch })

// ─── Units adapter ─────────────────────────────────────────────────────────

describe('legacyPowerConfigFromKw', () => {
  it('converts every kW/kWh value to W/Wh instead of renaming fields', () => {
    expect(config()).toEqual({
      normalLoadW: 2000,
      essentialLoadW: 500,
      initialEnergyWh: 50_000,
      capacityWh: 100_000,
      maxSolarW: 4000,
      minReserveWh: 10_000,
    })
  })
  it('keeps the former placeholder defaults as the isolated legacy placeholder', () => {
    expect(LEGACY_PLACEHOLDER_POWER_CONFIG).toEqual(config())
    expect(Object.isFrozen(LEGACY_PLACEHOLDER_POWER_CONFIG)).toBe(true)
  })
})

// ─── Validation ────────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts valid defaults', () => {
    expect(validateConfig(LEGACY_PLACEHOLDER_POWER_CONFIG)).toEqual([])
  })
  it('rejects a zero-length mission (duration now lives in the window, not the config)', () => {
    expect(validateMissionWindow(win(0))).toHaveLength(1)
    expect(() => simulatePower(config(), win(0), [])).toThrow(/window/i)
  })
  it('rejects negative load', () => {
    expect(validateConfig(config({ normalLoadKw: -1 }))).toHaveLength(1)
  })
  it('rejects essential > normal', () => {
    expect(validateConfig(config({ essentialLoadKw: 5 }))).toHaveLength(1)
  })
  it('rejects initial charge > max capacity', () => {
    expect(validateConfig(config({ initialChargeKwh: 200 }))).toHaveLength(1)
  })
  it('rejects reserve > capacity', () => {
    expect(validateConfig(config({ minReserveKwh: 200 })).length).toBeGreaterThanOrEqual(1)
  })
  it('rejects NaN and Infinity', () => {
    expect(validateConfig(config({ maxSolarKw: Number.NaN }))).toHaveLength(1)
    expect(validateConfig(config({ normalLoadKw: Infinity }))).toHaveLength(1)
  })
  it('makes simulatePower validate too, not only assessViability', () => {
    expect(() => simulatePower(config({ normalLoadKw: -1 }), win(10), [])).toThrow(/Normal power consumption/)
    expect(() => simulatePower(config(), win(10), [], { dtMs: 0 })).toThrow(/dtMs/)
  })
})

describe('validateSchedule', () => {
  it('accepts an empty schedule', () => {
    expect(validateSchedule([], hours(100))).toEqual([])
  })
  it('rejects a gap', () => {
    const sched = [
      { startOffsetMs: 0, endOffsetMs: hours(50), loadW: 2000 },
      { startOffsetMs: hours(60), endOffsetMs: hours(100), loadW: 2000 },
    ]
    expect(validateSchedule(sched, hours(100)).length).toBeGreaterThan(0)
  })
  it('rejects a schedule that does not reach the mission end', () => {
    const sched = [{ startOffsetMs: 0, endOffsetMs: hours(80), loadW: 2000 }]
    expect(validateSchedule(sched, hours(100)).length).toBeGreaterThan(0)
  })
})

// ─── Test 1: Continuous sunlight ───────────────────────────────────────────

describe('continuous sunlight', () => {
  it('is viable and the battery charges to full', () => {
    const c = config()
    const sun = sunIv(START, [[0, 24]]) // sun up the entire mission
    const r = simulatePower(c, win(24), sun)
    expect(r.viable).toBe(true)
    expect(r.totalDeficitWh).toBe(0)
    expect(r.totalSolarWh).toBeGreaterThan(0)
    // net = 4 - 2 = 2 kW surplus; 50 + 2*24 = 98 kWh (doesn't quite fill 100)
    const last = r.timeline[r.timeline.length - 1]
    expect(last.energyWh).toBeGreaterThan(c.initialEnergyWh)
  })
})

// ─── Test 2: Continuous darkness ───────────────────────────────────────────

describe('continuous darkness', () => {
  it('depletes the battery and is nonviable', () => {
    const r = simulatePower(config({ initialChargeKwh: 50 }), win(48), [])
    expect(r.viable).toBe(false)
    expect(r.totalSolarWh).toBe(0)
    expect(r.totalDeficitWh).toBeGreaterThan(0)
    expect(r.reason).toMatch(/deplet/i)
  })
  it('is viable if battery is large enough for the whole dark stay', () => {
    const r = simulatePower(config({ initialChargeKwh: 100, minReserveKwh: 0 }), win(10), [])
    // 2 kW * 10 h = 20 kWh consumed, 100 - 20 = 80 kWh remaining
    expect(r.viable).toBe(true)
    expect(kWh(r.lowestEnergyWh)).toBeCloseTo(80, 0)
  })
})

// ─── Test 3: Alternating sunlight and darkness ─────────────────────────────

describe('alternating sunlight and darkness', () => {
  it('survives alternating 6h sun / 6h dark cycles', () => {
    // 4 cycles of 6h sun, 6h dark
    const sun = sunIv(START, [[0, 6], [12, 18], [24, 30], [36, 42]])
    const r = simulatePower(config({ initialChargeKwh: 50 }), win(48), sun)
    expect(r.viable).toBe(true)
    expect(r.totalSolarWh).toBeGreaterThan(0)
    expect(r.totalConsumedWh).toBeGreaterThan(0)
  })
})

// ─── Test 4: Prolonged uninterrupted darkness ──────────────────────────────

describe('prolonged darkness', () => {
  it('fails when a long dark stretch exceeds battery capacity', () => {
    // 50 kWh battery, 2 kW load => 25 hours of darkness is the max; sun for first 6h, then 54h of darkness
    const r = simulatePower(config({ initialChargeKwh: 50, minReserveKwh: 0 }), win(60), sunIv(START, [[0, 6]]))
    expect(r.viable).toBe(false)
    expect(r.totalDeficitWh).toBeGreaterThan(0)
  })
})

// ─── Test 8: Solar exceeds consumption ─────────────────────────────────────

describe('solar exceeds consumption', () => {
  it('battery caps at maximum capacity', () => {
    const c = config({ maxSolarKw: 10, normalLoadKw: 1, initialChargeKwh: 20 })
    const r = simulatePower(c, win(48), sunIv(START, [[0, 48]]))
    expect(r.viable).toBe(true)
    const last = r.timeline[r.timeline.length - 1]
    expect(kWh(last.energyWh)).toBeCloseTo(kWh(c.capacityWh), 0)
  })
})

// ─── Test 9: Solar below consumption ───────────────────────────────────────

describe('solar below consumption', () => {
  it('battery drains even during sunlight', () => {
    const c = config({ maxSolarKw: 1, normalLoadKw: 3, initialChargeKwh: 100, minReserveKwh: 0 })
    const r = simulatePower(c, win(100), sunIv(START, [[0, 100]]))
    // net = 1 - 3 = -2 kW, 100 kWh / 2 kW = 50h, mission is 100h
    expect(r.viable).toBe(false)
    expect(r.totalDeficitWh).toBeGreaterThan(0)
  })
})

// ─── Test 10: Battery reaching maximum capacity ───────────────────────────

describe('battery reaching maximum capacity', () => {
  it('charge is clamped and excess solar energy is discarded', () => {
    // Start near full, lots of sun
    const c = config({ initialChargeKwh: 95, maxSolarKw: 10, normalLoadKw: 1 })
    const r = simulatePower(c, win(24), sunIv(START, [[0, 24]]))
    expect(r.viable).toBe(true)
    // Should hit cap quickly and stay there (within 0.5 kWh)
    const capped = r.timeline.filter((s) => Math.abs(kWh(s.energyWh - c.capacityWh)) < 0.5)
    expect(capped.length).toBeGreaterThan(r.timeline.length / 2)
    // Total solar generated is more than total consumed (excess discarded)
    expect(r.totalSolarWh).toBeGreaterThan(r.totalConsumedWh)
  })
})

// ─── Test 11: Battery approaching minimum reserve ─────────────────────────

describe('battery approaching minimum reserve', () => {
  it('is nonviable when charge dips below reserve even if it recovers', () => {
    // 50 kWh battery, 10 kWh reserve, 2 kW load, darkness for 21h then sun
    // After 20h: 50 - 2*20 = 10 kWh = reserve. At 20h+ε it dips below.
    const r = simulatePower(config({ initialChargeKwh: 50, minReserveKwh: 10 }), win(48), sunIv(START, [[21, 48]]))
    expect(r.timeline.some((s) => s.reserveBreached)).toBe(true)
    // charge recovers, but the breach happened
    expect(r.viable).toBe(false)
    expect(r.reason).toMatch(/reserve/i)
  })
  it('is viable when darkness ends just before reserve is hit', () => {
    // 2 kW * 19h = 38 kWh consumed, 50 - 38 = 12 kWh > 10 kWh reserve
    const c = config({ initialChargeKwh: 50, minReserveKwh: 10 })
    const r = simulatePower(c, win(48), sunIv(START, [[19, 48]]))
    expect(r.viable).toBe(true)
    expect(kWh(r.lowestEnergyWh)).toBeGreaterThanOrEqual(kWh(c.minReserveWh) - 0.5)
  })
})

// ─── Test 12: Battery depletion before mission completion ─────────────────

describe('battery depletion before completion', () => {
  it('records the deficit and the time of lowest charge', () => {
    const r = simulatePower(config({ initialChargeKwh: 20, minReserveKwh: 0 }), win(48), []) // total darkness
    expect(r.viable).toBe(false)
    expect(r.totalDeficitWh).toBeGreaterThan(0)
    // Battery hits 0 at 20/2 = 10 hours; lowestEnergyAtMs is absolute UTC
    expect(r.lowestEnergyWh).toBe(0)
    expect(r.lowestEnergyAtMs).toBeCloseTo(START + hours(10), -4)
  })
})

// ─── Test 13: Changing vessel power consumption ───────────────────────────

describe('variable power consumption', () => {
  it('uses the schedule load instead of normalLoadW', () => {
    // First 10h at 1 kW, next 10h at 3 kW => total = 10 + 30 = 40 kWh. Offsets are relative to landing.
    const schedule = [
      { startOffsetMs: 0, endOffsetMs: hours(10), loadW: kwToW(1) },
      { startOffsetMs: hours(10), endOffsetMs: hours(20), loadW: kwToW(3) },
    ]
    const r = simulatePower(config({ initialChargeKwh: 100, minReserveKwh: 0 }), win(20), [], { schedule })
    expect(kWh(r.totalConsumedWh)).toBeCloseTo(40, 0)
    expect(r.viable).toBe(true)
    // charge = 100 - 40 = 60
    const last = r.timeline[r.timeline.length - 1]
    expect(kWh(last.energyWh)).toBeCloseTo(60, 0)
  })
  it('high-load segment causes depletion that low-load segment would not', () => {
    const c = config({ initialChargeKwh: 30, minReserveKwh: 0 })
    // Constant 1 kW: 20 kWh consumed, 30 - 20 = 10 kWh remaining → viable
    const rConst = simulatePower(c, win(20), [], {
      schedule: [{ startOffsetMs: 0, endOffsetMs: hours(20), loadW: kwToW(1) }],
    })
    expect(rConst.viable).toBe(true)
    // First 10h at 1 kW (10 kWh), next 10h at 5 kW (50 kWh) = 60 kWh > 30 → depleted
    const rVar = simulatePower(c, win(20), [], {
      schedule: [
        { startOffsetMs: 0, endOffsetMs: hours(10), loadW: kwToW(1) },
        { startOffsetMs: hours(10), endOffsetMs: hours(20), loadW: kwToW(5) },
      ],
    })
    expect(rVar.viable).toBe(false)
  })
  it('treats segment times as offsets from landing, independent of the absolute start', () => {
    const schedule = [
      { startOffsetMs: 0, endOffsetMs: hours(10), loadW: kwToW(1) },
      { startOffsetMs: hours(10), endOffsetMs: hours(20), loadW: kwToW(3) },
    ]
    const c = config({ initialChargeKwh: 100, minReserveKwh: 0 })
    const a = simulatePower(c, win(20), [], { schedule })
    const b = simulatePower(c, win(20, Date.UTC(2031, 0, 1)), [], { schedule })
    expect(b.totalConsumedWh).toBeCloseTo(a.totalConsumedWh, 6)
    expect(b.timeline[0].tMs).toBe(Date.UTC(2031, 0, 1))
  })
})

// ─── Test 5: Low Sun elevation with direct sunlight reaching panels ───────

describe('low Sun elevation (legacy binary model)', () => {
  it('produces full rated output regardless of elevation angle', () => {
    // The binary model says: sun up → full output. Replaced by panel geometry in step 11.
    const c = config({ initialChargeKwh: 50 })
    const r = simulatePower(c, win(10), sunIv(START, [[0, 10]]))
    for (const s of r.timeline) {
      if (s.sunUp) expect(s.solarW).toBe(c.maxSolarW)
    }
    // Total solar = maxSolar 4 kW * 10h = 40 kWh
    expect(kWh(r.totalSolarWh)).toBeCloseTo(40, 0)
  })
})

// ─── Test 6: Partial panel illumination produces max output ────────────────

describe('partial panel illumination (legacy binary model)', () => {
  it('any sunUp = true step gives full rated output, never a fraction', () => {
    const c = config()
    // Short sun windows simulating near-horizon conditions
    const r = simulatePower(c, win(24), sunIv(START, [[2, 2.5], [8, 8.1], [14, 16], [20, 20.05]]))
    const sunSteps = r.timeline.filter((s) => s.sunUp)
    expect(sunSteps.length).toBeGreaterThan(0)
    for (const s of sunSteps) expect(s.solarW).toBe(c.maxSolarW)
    // Dark steps should be exactly 0
    for (const s of r.timeline.filter((x) => !x.sunUp)) expect(s.solarW).toBe(0)
  })
})

// ─── Test 7: No sunlight reaching any portion of the panel ─────────────────

describe('no sunlight at all', () => {
  it('every step has zero solar output', () => {
    const r = simulatePower(config({ initialChargeKwh: 100, minReserveKwh: 0 }), win(24), [])
    expect(r.totalSolarWh).toBe(0)
    for (const s of r.timeline) {
      expect(s.solarW).toBe(0)
      expect(s.sunUp).toBe(false)
    }
  })
})

// ─── Test 14: Different patterns, same cumulative sunlight ─────────────────

describe('pattern sensitivity', () => {
  it('same total sunlight but different timing gives different viability', () => {
    // Both patterns have 20h of sunlight in a 48h mission.
    const c = config({ initialChargeKwh: 30, minReserveKwh: 0 })

    // Pattern A: one block of sun at the start.
    // After 20h sun: charge = min(100, 30 + (4-2)*20) = 70. Then 28h dark: 70 - 2*28 = 14 → viable
    const rA = simulatePower(c, win(48), sunIv(START, [[0, 20]]))
    expect(rA.viable).toBe(true)

    // Pattern B: 4 cycles of 5h sun / 7h dark = 20h sun / 28h dark total
    const rB = simulatePower(c, win(48), sunIv(START, [[0, 5], [12, 17], [24, 29], [36, 41]]))

    // Both have the same total sunlight hours
    expect(kWh(rA.totalSolarWh)).toBeCloseTo(kWh(rB.totalSolarWh), 0)

    // At t=24h, pattern A is deep into darkness while B just recharged.
    const atA = rA.timeline.find((s) => s.tMs >= START + hours(24))!
    const atB = rB.timeline.find((s) => s.tMs >= START + hours(24))!
    expect(kWh(atA.energyWh)).not.toBeCloseTo(kWh(atB.energyWh), 0)
  })
})

// ─── Test 15: Viable mission becomes nonviable with longer stay ────────────

describe('stay length sensitivity', () => {
  it('extending the stay makes a viable mission nonviable', () => {
    // Sun for 10h, then permanent darkness
    const makeSun = (stay: number) => sunIv(START, [[0, Math.min(10, stay)]])
    const c = config({ initialChargeKwh: 50, minReserveKwh: 0 })

    // 10h sun: charge goes to min(100, 50 + 2*10) = 70. Then 20h dark: 70 - 2*20 = 30 → viable
    expect(simulatePower(c, win(30), makeSun(30)).viable).toBe(true)
    // 10h sun: charge = 70. Then 50h dark: 70 - 2*50 = -30 → depleted
    expect(simulatePower(c, win(60), makeSun(60)).viable).toBe(false)
  })
})

// ─── Regression across the step 03 interface migration ─────────────────────

describe('legacy assessViability regression', () => {
  // Reference values captured from the pre-step-03 code (kW/kWh, stayMs inside the config) with
  // site (20 N, 30 E), smooth sphere, landing 2026-11-13 00:00 UTC, 20-day stay, placeholder config with
  // 60 kWh initial charge. Same physical inputs must give the same results, now in W/Wh.
  it('reproduces the pre-migration result', () => {
    const c = { ...LEGACY_PLACEHOLDER_POWER_CONFIG, initialEnergyWh: 60_000 }
    const r = assessViability({ lat: 20, lon: 30 }, win(20 * 24), c)
    expect(r.viable).toBe(false)
    expect(r.reason).toBe('Battery depleted: unmet energy demand')
    expect(r.timeline).toHaveLength(5761)
    expect(r.sunIntervals).toEqual([{ start: 1794663330908.2031, end: 1795939682958.9844 }])
    expect(kWh(r.totalSolarWh)).toBeCloseTo(1418, 6)
    expect(kWh(r.totalConsumedWh)).toBeCloseTo(960, 6)
    expect(kWh(r.totalDeficitWh)).toBeCloseTo(91, 6)
    expect(r.lowestEnergyWh).toBe(0)
    expect(r.lowestEnergyAtMs).toBe(1794636300000)
    expect(kWh(r.minReserveMarginWh)).toBeCloseTo(-10, 9)
  })
})
