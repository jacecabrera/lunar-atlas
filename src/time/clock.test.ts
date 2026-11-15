// Scene clock with controllable clocks (pure transitions in time/clock.ts).
import { describe, expect, it } from 'vitest'
import * as C from './clock'
import { CLOCK_CONFIG } from '../state/timeStore'

const t = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()
const NOW = t('2026-11-15T10:20:30Z')
const cfg = CLOCK_CONFIG
const init = (now = NOW, wall = 0) => C.initialClock(now, wall, cfg)

describe('initial state and defaults', () => {
  it('cursor at now, range now +/- 1 UTC calendar year from one captured instant, autoplay at 1x', () => {
    const s = init()
    expect(s.t).toBe(NOW)
    expect(iso(s.min)).toBe('2025-11-15T10:20:30.000Z')
    expect(iso(s.max)).toBe('2027-11-15T10:20:30.000Z')
    expect(s).toMatchObject({ playing: true, rate: 1, lock: null })
    const leap = init(t('2028-02-29T00:00:00Z'))
    expect(iso(leap.min)).toBe('2027-02-28T00:00:00.000Z') // calendar years with the Feb 29 rule, not 365 days
    expect(iso(leap.max)).toBe('2029-02-28T00:00:00.000Z')
  })
})

describe('playback', () => {
  it('1x follows elapsed time; every configured speed scales it; frame rate does not matter', () => {
    expect(cfg.playbackSpeeds).toEqual([1, 1.25, 1.5, 2, 3, 5])
    for (const r of cfg.playbackSpeeds) {
      const s = C.setRate(init(), r, 0, cfg)
      expect(C.advance(s, 10_000).t - NOW).toBeCloseTo(10_000 * r, 9)
    }
    // 60 Hz vs 7 Hz ticking over the same 2 s give the same time.
    let a = init(), b = init()
    for (let w = 0; w <= 2000; w += 1000 / 60) a = C.advance(a, w)
    for (let w = 0; w <= 2000; w += 1000 / 7) b = C.advance(b, w)
    a = C.advance(a, 2000); b = C.advance(b, 2000)
    expect(a.t).toBe(b.t)
    expect(C.setRate(init(), 4, 0, cfg).notice).toMatch(/Unsupported/)
  })
  it('pause, resume and speed changes re-anchor without jumps or double counting', () => {
    let s = init()
    s = C.pause(s, 1000) // +1 s
    s = C.advance(s, 5000) // paused: no change
    expect(s.t).toBe(NOW + 1000)
    s = C.play(s, 5000)
    s = C.setRate(s, 2, 6000, cfg) // +1 s at 1x
    s = C.advance(s, 8000) // +2 s at 2x = 4 s
    expect(s.t).toBe(NOW + 1000 + 1000 + 4000)
  })
  it('a hidden tab catches up from the anchor; a paused or locked clock does not; the end pauses playback', () => {
    let s = C.advance(init(), 3_600_000) // one hour without frames
    expect(s.t).toBe(NOW + 3_600_000)
    expect(C.advance(C.pause(init(), 0), 3_600_000).t).toBe(NOW)
    expect(C.advance(C.lockToLanding(init(), NOW + 5, 'r'), 3_600_000).t).toBe(NOW + 5)
    s = C.advance(C.setRate(init(), 5, 0, cfg), 400 * 86_400_000) // past the end
    expect(s).toMatchObject({ t: s.max, playing: false })
    expect(C.play(s, 0).playing).toBe(false) // no wrap at the end
  })
})

describe('jumps and ranges', () => {
  it('a manual jump pauses; outside the range or invalid it is refused', () => {
    const s = C.seek(init(), NOW + 60_000)
    expect(s).toMatchObject({ t: NOW + 60_000, playing: false })
    expect(C.seek(init(), NOW + 3 * 365 * 86_400_000).t).toBe(NOW)
    expect(C.seek(init(), Number.NaN).notice).toMatch(/Invalid/)
  })
  it('a range that excludes the cursor pauses and moves it to the nearest edge with a notice', () => {
    const s = C.setRange(init(), NOW + 86_400_000, NOW + 2 * 86_400_000, 0)
    expect(s).toMatchObject({ t: NOW + 86_400_000, playing: false })
    expect(s.notice).toMatch(/nearest edge/)
    expect(C.setRange(init(), NOW, NOW, 0).notice).toMatch(/before its end/)
    expect(C.setRange(init(), Number.NaN, NOW, 0).notice).toMatch(/valid UTC/)
  })
  it('parses UTC strictly: leap day ok, 29 Feb in a common year and other rollovers refused; local time zone ignored', () => {
    expect(C.parseUtcInput('2028-02-29 12:34:56')).toBe(Date.UTC(2028, 1, 29, 12, 34, 56))
    expect(C.parseUtcInput('2028-02-29T12:34:56Z')).toBe(Date.UTC(2028, 1, 29, 12, 34, 56))
    expect(C.parseUtcInput('2027-02-29 00:00:00')).toBeNull()
    expect(C.parseUtcInput('2027-04-31 00:00:00')).toBeNull()
    expect(C.parseUtcInput('2027-01-01 24:00:00')).toBeNull()
    expect(C.parseUtcInput('2027-01-31 23:59:60')).toBeNull()
    expect(C.parseUtcInput('yesterday')).toBeNull()
    expect(C.formatUtc(Date.UTC(2027, 0, 31, 23, 59, 59))).toBe('2027-01-31 23:59:59 UTC')
  })
})

describe('calculation lock', () => {
  it('pauses, jumps and locks; play, seek and range edits that would move it are refused', () => {
    const landing = NOW + 30 * 86_400_000
    let s = C.lockToLanding(init(), landing, 'req-1')
    expect(s).toMatchObject({ t: landing, playing: false, lock: { landingMs: landing, requestId: 'req-1' } })
    for (const next of [C.play(s, 0), C.seek(s, NOW), C.setRange(s, NOW, NOW + 86_400_000, 0)]) expect(next.t).toBe(landing)
    expect(C.play(s, 0).playing).toBe(false)
    s = C.setRate(s, 2, 0, cfg) // allowed, but the locked clock does not move
    expect(C.advance(s, 10_000).t).toBe(landing)
  })
  it('extends only the needed end to include a Landing Time outside the range', () => {
    const s0 = init()
    const late = C.lockToLanding(s0, s0.max + 1234, 'r')
    expect(late).toMatchObject({ min: s0.min, max: s0.max + 1234, t: s0.max + 1234 })
    const early = C.lockToLanding(s0, s0.min - 99, 'r')
    expect(early).toMatchObject({ min: s0.min - 99, max: s0.max })
  })
  it('a new valid calculation moves the lock to its Landing Time', () => {
    const s = C.lockToLanding(C.lockToLanding(init(), NOW + 1000, 'a'), NOW + 2000, 'b')
    expect(s.lock).toEqual({ landingMs: NOW + 2000, requestId: 'b' })
  })
})

describe('confirmed reset (time side)', () => {
  const locked = () => C.setRate(C.lockToLanding(init(), NOW + 5000, 'r'), 3, 0, cfg)
  it('now inside the range (ends included): both ends kept; unlock, 1x, autoplay at now', () => {
    const s0 = locked()
    for (const now of [s0.min, NOW + 86_400_000, s0.max]) {
      const s = C.resetTimeConfirmed(s0, now, 0, cfg)
      expect(s).toMatchObject({ t: now, min: s0.min, max: s0.max, lock: null, rate: 1, playing: true })
    }
  })
  it('now before the start: only the start moves to now - 1 calendar month', () => {
    const s0 = locked()
    const now = t('2024-03-31T08:00:00Z')
    const s = C.resetTimeConfirmed(s0, now, 0, cfg)
    expect(iso(s.min)).toBe('2024-02-29T08:00:00.000Z') // month end clamped (leap year)
    expect(s.max).toBe(s0.max)
  })
  it('now after the end: only the end moves to now + 1 calendar year; the default range is not restored', () => {
    const s0 = locked()
    const now = t('2032-02-29T08:00:00Z')
    const s = C.resetTimeConfirmed(s0, now, 0, cfg)
    expect(s.min).toBe(s0.min)
    expect(iso(s.max)).toBe('2033-02-28T08:00:00.000Z')
  })
})
