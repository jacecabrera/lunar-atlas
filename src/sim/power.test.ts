import { describe, expect, it } from 'vitest'
import {
  validateConfig, validateSchedule, simulatePower,
  DEFAULT_POWER_CONFIG,
} from './power'
import type { PowerConfig } from './power'
import type { Interval } from '../physics/siteTimeline'

// ─── helpers ───────────────────────────────────────────────────────────────

const HOUR = 3_600_000
const hours = (h: number) => h * HOUR

/** Build sun intervals: list of [startH, endH] in hours from mission start */
const sunIv = (start: number, pairs: [number, number][]): Interval[] =>
  pairs.map(([a, b]) => ({ start: start + hours(a), end: start + hours(b) }))

const baseConfig = (patch: Partial<PowerConfig> = {}): PowerConfig => ({
  ...DEFAULT_POWER_CONFIG,
  stayMs: hours(100),
  normalLoadKw: 2,
  essentialLoadKw: 0.5,
  initialChargeKwh: 50,
  maxCapacityKwh: 100,
  maxSolarKw: 4,
  minReserveKwh: 10,
  ...patch,
})

// ─── Validation ────────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts valid defaults', () => {
    expect(validateConfig(DEFAULT_POWER_CONFIG)).toEqual([])
  })
  it('rejects zero stay', () => {
    expect(validateConfig(baseConfig({ stayMs: 0 }))).toHaveLength(1)
  })
  it('rejects negative load', () => {
    expect(validateConfig(baseConfig({ normalLoadKw: -1 }))).toHaveLength(1)
  })
  it('rejects essential > normal', () => {
    expect(validateConfig(baseConfig({ essentialLoadKw: 5 }))).toHaveLength(1)
  })
  it('rejects initial charge > max capacity', () => {
    expect(validateConfig(baseConfig({ initialChargeKwh: 200 }))).toHaveLength(1)
  })
  it('rejects reserve > capacity', () => {
    expect(validateConfig(baseConfig({ minReserveKwh: 200 })).length).toBeGreaterThanOrEqual(1)
  })
})

describe('validateSchedule', () => {
  it('accepts an empty schedule', () => {
    expect(validateSchedule([], hours(100))).toEqual([])
  })
  it('rejects a gap', () => {
    const sched = [
      { startMs: 0, endMs: hours(50), loadKw: 2 },
      { startMs: hours(60), endMs: hours(100), loadKw: 2 },
    ]
    expect(validateSchedule(sched, hours(100)).length).toBeGreaterThan(0)
  })
  it('rejects a schedule that does not reach the mission end', () => {
    const sched = [{ startMs: 0, endMs: hours(80), loadKw: 2 }]
    expect(validateSchedule(sched, hours(100)).length).toBeGreaterThan(0)
  })
})

// ─── Test 1: Continuous sunlight ───────────────────────────────────────────

describe('continuous sunlight', () => {
  it('is viable and the battery charges to full', () => {
    const cfg = baseConfig({ stayMs: hours(24) })
    const start = Date.UTC(2026, 10, 13)
    const sun = sunIv(start, [[0, 24]]) // sun up the entire mission
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(true)
    expect(r.totalDeficitKwh).toBe(0)
    expect(r.totalSolarKwh).toBeGreaterThan(0)
    // net = 4 - 2 = 2 kW surplus; 50 + 2*24 = 98 kWh (doesn't quite fill 100)
    const last = r.timeline[r.timeline.length - 1]
    expect(last.chargeKwh).toBeGreaterThan(cfg.initialChargeKwh)
  })
})

// ─── Test 2: Continuous darkness ───────────────────────────────────────────

describe('continuous darkness', () => {
  it('depletes the battery and is nonviable', () => {
    const cfg = baseConfig({ stayMs: hours(48), initialChargeKwh: 50 })
    const start = Date.UTC(2026, 10, 13)
    const sun: Interval[] = [] // no sunlight at all
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(false)
    expect(r.totalSolarKwh).toBe(0)
    expect(r.totalDeficitKwh).toBeGreaterThan(0)
    expect(r.reason).toMatch(/deplet/i)
  })
  it('is viable if battery is large enough for the whole dark stay', () => {
    const cfg = baseConfig({ stayMs: hours(10), initialChargeKwh: 100, minReserveKwh: 0 })
    const start = Date.UTC(2026, 10, 13)
    const r = simulatePower(cfg, [], start)
    // 2 kW * 10 h = 20 kWh consumed, 100 - 20 = 80 kWh remaining
    expect(r.viable).toBe(true)
    expect(r.lowestChargeKwh).toBeCloseTo(80, 0)
  })
})

// ─── Test 3: Alternating sunlight and darkness ─────────────────────────────

describe('alternating sunlight and darkness', () => {
  it('survives alternating 6h sun / 6h dark cycles', () => {
    const cfg = baseConfig({ stayMs: hours(48), initialChargeKwh: 50 })
    const start = Date.UTC(2026, 10, 13)
    // 4 cycles of 6h sun, 6h dark
    const sun = sunIv(start, [[0, 6], [12, 18], [24, 30], [36, 42]])
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(true)
    expect(r.totalSolarKwh).toBeGreaterThan(0)
    expect(r.totalConsumedKwh).toBeGreaterThan(0)
  })
})

// ─── Test 4: Prolonged uninterrupted darkness ──────────────────────────────

describe('prolonged darkness', () => {
  it('fails when a long dark stretch exceeds battery capacity', () => {
    // 50 kWh battery, 2 kW load => 25 hours of darkness is the max
    const cfg = baseConfig({ stayMs: hours(60), initialChargeKwh: 50, minReserveKwh: 0 })
    const start = Date.UTC(2026, 10, 13)
    // sun for first 6h, then 54h of darkness
    const sun = sunIv(start, [[0, 6]])
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(false)
    expect(r.totalDeficitKwh).toBeGreaterThan(0)
  })
})

// ─── Test 8: Solar exceeds consumption ─────────────────────────────────────

describe('solar exceeds consumption', () => {
  it('battery caps at maximum capacity', () => {
    const cfg = baseConfig({ stayMs: hours(48), maxSolarKw: 10, normalLoadKw: 1, initialChargeKwh: 20 })
    const start = Date.UTC(2026, 10, 13)
    const sun = sunIv(start, [[0, 48]])
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(true)
    const last = r.timeline[r.timeline.length - 1]
    expect(last.chargeKwh).toBeCloseTo(cfg.maxCapacityKwh, 0)
  })
})

// ─── Test 9: Solar below consumption ───────────────────────────────────────

describe('solar below consumption', () => {
  it('battery drains even during sunlight', () => {
    const cfg = baseConfig({ stayMs: hours(100), maxSolarKw: 1, normalLoadKw: 3, initialChargeKwh: 100, minReserveKwh: 0 })
    const start = Date.UTC(2026, 10, 13)
    const sun = sunIv(start, [[0, 100]])
    const r = simulatePower(cfg, sun, start)
    // net = 1 - 3 = -2 kW, 100 kWh / 2 kW = 50h, mission is 100h
    expect(r.viable).toBe(false)
    expect(r.totalDeficitKwh).toBeGreaterThan(0)
  })
})

// ─── Test 10: Battery reaching maximum capacity ───────────────────────────

describe('battery reaching maximum capacity', () => {
  it('charge is clamped and excess solar energy is discarded', () => {
    // Start near full, lots of sun
    const cfg = baseConfig({ stayMs: hours(24), initialChargeKwh: 95, maxSolarKw: 10, normalLoadKw: 1 })
    const start = Date.UTC(2026, 10, 13)
    const sun = sunIv(start, [[0, 24]])
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(true)
    // Should hit cap quickly and stay there
    const capped = r.timeline.filter((s) => Math.abs(s.chargeKwh - cfg.maxCapacityKwh) < 0.5)
    expect(capped.length).toBeGreaterThan(r.timeline.length / 2)
    // Total solar generated is more than total consumed (excess discarded)
    expect(r.totalSolarKwh).toBeGreaterThan(r.totalConsumedKwh)
  })
})

// ─── Test 11: Battery approaching minimum reserve ─────────────────────────

describe('battery approaching minimum reserve', () => {
  it('is nonviable when charge dips below reserve even if it recovers', () => {
    // 50 kWh battery, 10 kWh reserve, 2 kW load, darkness for 21h then sun
    // After 20h: 50 - 2*20 = 10 kWh = reserve. At 20h+ε it dips below.
    const cfg = baseConfig({ stayMs: hours(48), initialChargeKwh: 50, minReserveKwh: 10 })
    const start = Date.UTC(2026, 10, 13)
    const sun = sunIv(start, [[21, 48]]) // sun returns after 21h
    const r = simulatePower(cfg, sun, start)
    expect(r.timeline.some((s) => s.reserveBreached)).toBe(true)
    // charge recovers, but the breach happened
    expect(r.viable).toBe(false)
    expect(r.reason).toMatch(/reserve/i)
  })
  it('is viable when darkness ends just before reserve is hit', () => {
    // 2 kW * 19h = 38 kWh consumed, 50 - 38 = 12 kWh > 10 kWh reserve
    const cfg = baseConfig({ stayMs: hours(48), initialChargeKwh: 50, minReserveKwh: 10 })
    const start = Date.UTC(2026, 10, 13)
    const sun = sunIv(start, [[19, 48]])
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(true)
    expect(r.lowestChargeKwh).toBeGreaterThanOrEqual(cfg.minReserveKwh - 0.5)
  })
})

// ─── Test 12: Battery depletion before mission completion ─────────────────

describe('battery depletion before completion', () => {
  it('records the deficit and the time of lowest charge', () => {
    const cfg = baseConfig({ stayMs: hours(48), initialChargeKwh: 20, minReserveKwh: 0 })
    const start = Date.UTC(2026, 10, 13)
    const sun: Interval[] = [] // total darkness
    const r = simulatePower(cfg, sun, start)
    expect(r.viable).toBe(false)
    expect(r.totalDeficitKwh).toBeGreaterThan(0)
    // Battery hits 0 at 20/2 = 10 hours
    expect(r.lowestChargeKwh).toBe(0)
    expect(r.lowestChargeAtMs).toBeCloseTo(start + hours(10), -4)
  })
})

// ─── Test 13: Changing vessel power consumption ───────────────────────────

describe('variable power consumption', () => {
  it('uses the schedule load instead of normalLoadKw', () => {
    const cfg = baseConfig({ stayMs: hours(20), initialChargeKwh: 100, minReserveKwh: 0 })
    const start = Date.UTC(2026, 10, 13)
    const sun: Interval[] = [] // all dark to isolate consumption
    // First 10h at 1 kW, next 10h at 3 kW => total = 10 + 30 = 40 kWh
    const schedule = [
      { startMs: 0, endMs: hours(10), loadKw: 1 },
      { startMs: hours(10), endMs: hours(20), loadKw: 3 },
    ]
    const r = simulatePower(cfg, sun, start, { schedule })
    expect(r.totalConsumedKwh).toBeCloseTo(40, 0)
    expect(r.viable).toBe(true)
    // charge = 100 - 40 = 60
    const last = r.timeline[r.timeline.length - 1]
    expect(last.chargeKwh).toBeCloseTo(60, 0)
  })
  it('high-load segment causes depletion that low-load segment would not', () => {
    const cfg = baseConfig({ stayMs: hours(20), initialChargeKwh: 30, minReserveKwh: 0 })
    const start = Date.UTC(2026, 10, 13)
    const sun: Interval[] = []
    // Constant 1 kW: 20 kWh consumed, 30 - 20 = 10 kWh remaining → viable
    const rConst = simulatePower(cfg, sun, start, { schedule: [{ startMs: 0, endMs: hours(20), loadKw: 1 }] })
    expect(rConst.viable).toBe(true)
    // First 10h at 1 kW (10 kWh), next 10h at 5 kW (50 kWh) = 60 kWh > 30 → depleted
    const rVar = simulatePower(cfg, sun, start, {
      schedule: [
        { startMs: 0, endMs: hours(10), loadKw: 1 },
        { startMs: hours(10), endMs: hours(20), loadKw: 5 },
      ],
    })
    expect(rVar.viable).toBe(false)
  })
})
