import { describe, expect, it } from 'vitest'
import {
  EMPTY_MISSION_DRAFT, validateMissionDraft, missionInputStatus, missionWindow, validateMissionWindow,
} from './mission'
import type { MissionDraft } from './mission'
import { kwToW, wToKw, kwhToWh, whToKwh, daysToMs, msToDays, msToHours, hoursToMs, MS_PER_DAY } from './units'

const LANDING = Date.UTC(2027, 0, 15, 6, 30)
const VALID: MissionDraft = { landingTimeMs: LANDING, durationDays: 14, launchLat: 28.5, launchLon: -80.6 }
const draft = (patch: Partial<MissionDraft>): MissionDraft => ({ ...VALID, ...patch })
const fields = (d: MissionDraft) => validateMissionDraft(d).errors.map((e) => `${e.field}:${e.code}`)

describe('unit conversions', () => {
  it('converts power, energy and time without mixing scales', () => {
    expect(kwToW(2.5)).toBe(2500)
    expect(wToKw(23)).toBeCloseTo(0.023, 12)
    expect(kwhToWh(12)).toBe(12_000)
    expect(whToKwh(2400)).toBeCloseTo(2.4, 12)
    expect(daysToMs(1)).toBe(86_400_000)
    expect(daysToMs(0.5)).toBe(43_200_000)
    expect(msToDays(daysToMs(14))).toBe(14)
    expect(msToHours(hoursToMs(356.9))).toBeCloseTo(356.9, 9)
  })
})

describe('validateMissionDraft', () => {
  it('starts empty and reports empty, not invalid', () => {
    expect(EMPTY_MISSION_DRAFT).toEqual({ landingTimeMs: null, durationDays: null, launchLat: null, launchLon: null })
    expect(missionInputStatus(EMPTY_MISSION_DRAFT)).toBe('empty')
    expect(fields(EMPTY_MISSION_DRAFT)).toEqual([
      'landingTimeMs:required', 'durationDays:required', 'launchLat:required', 'launchLon:required',
    ])
  })

  it('turns a complete draft into a calculation input with the duration in ms', () => {
    const v = validateMissionDraft(VALID)
    expect(v.ok).toBe(true)
    expect(v.input).toEqual({ landingTimeMs: LANDING, durationMs: 14 * MS_PER_DAY, launchSite: { lat: 28.5, lon: -80.6 } })
    expect(missionWindow(v.input!)).toEqual({ startMs: LANDING, endMs: LANDING + 14 * MS_PER_DAY })
    expect(missionInputStatus(VALID)).toBe('valid')
  })

  it('accepts legitimate zero coordinates, which are not the same as missing ones', () => {
    expect(validateMissionDraft(draft({ launchLat: 0, launchLon: 0 })).ok).toBe(true)
    expect(fields(draft({ launchLat: null }))).toEqual(['launchLat:required'])
  })

  it('treats a partly filled draft as invalid', () => {
    expect(missionInputStatus({ ...EMPTY_MISSION_DRAFT, durationDays: 3 })).toBe('invalid')
  })

  it('rejects NaN and Infinity in every field', () => {
    expect(fields(draft({ landingTimeMs: Number.NaN }))).toEqual(['landingTimeMs:not-finite'])
    expect(fields(draft({ durationDays: Infinity }))).toEqual(['durationDays:not-finite'])
    expect(fields(draft({ launchLat: -Infinity }))).toEqual(['launchLat:not-finite'])
    expect(fields(draft({ launchLon: Number.NaN }))).toEqual(['launchLon:not-finite'])
  })

  it('requires a duration greater than zero', () => {
    expect(fields(draft({ durationDays: 0 }))).toEqual(['durationDays:not-positive'])
    expect(fields(draft({ durationDays: -1 }))).toEqual(['durationDays:not-positive'])
    expect(validateMissionDraft(draft({ durationDays: 0.25 })).input?.durationMs).toBe(6 * 3_600_000)
  })

  it('checks coordinate ranges, inclusive at the limits', () => {
    expect(validateMissionDraft(draft({ launchLat: 90, launchLon: -180 })).ok).toBe(true)
    expect(validateMissionDraft(draft({ launchLat: -90, launchLon: 180 })).ok).toBe(true)
    expect(fields(draft({ launchLat: 90.0001 }))).toEqual(['launchLat:out-of-range'])
    expect(fields(draft({ launchLon: 180.5 }))).toEqual(['launchLon:out-of-range'])
  })

  it('rejects instants outside the JavaScript date range', () => {
    expect(fields(draft({ landingTimeMs: 9e15 }))).toEqual(['landingTimeMs:out-of-range'])
    expect(fields(draft({ landingTimeMs: 8.6e15, durationDays: 1e6 }))).toEqual(['durationDays:out-of-range'])
  })

  it('uses English messages for the UI', () => {
    expect(validateMissionDraft(draft({ durationDays: 0 })).errors[0].message).toBe(
      'Duration of journey must be greater than 0 days',
    )
  })
})

describe('validateMissionWindow', () => {
  it('needs finite bounds and a positive length', () => {
    expect(validateMissionWindow({ startMs: 0, endMs: 1 })).toEqual([])
    expect(validateMissionWindow({ startMs: 5, endMs: 5 })).toHaveLength(1)
    expect(validateMissionWindow({ startMs: Number.NaN, endMs: 5 })).toHaveLength(1)
  })
})
