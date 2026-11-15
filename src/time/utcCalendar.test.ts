import { describe, expect, it } from 'vitest'
import { addUtcMonths, addUtcYears } from './utcCalendar'

const t = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()

describe('addUtcMonths', () => {
  it('keeps the time of day and moves by calendar months', () => {
    expect(iso(addUtcMonths(t('2026-11-14T21:05:33.250Z'), -1))).toBe('2026-10-14T21:05:33.250Z')
    expect(iso(addUtcMonths(t('2026-12-15T00:00:00Z'), 1))).toBe('2027-01-15T00:00:00.000Z')
    expect(iso(addUtcMonths(t('2026-01-15T00:00:00Z'), -1))).toBe('2025-12-15T00:00:00.000Z')
  })
  it('clamps to the last valid day of the target month', () => {
    expect(iso(addUtcMonths(t('2027-03-31T12:00:00Z'), -1))).toBe('2027-02-28T12:00:00.000Z')
    expect(iso(addUtcMonths(t('2028-03-31T12:00:00Z'), -1))).toBe('2028-02-29T12:00:00.000Z')
    expect(iso(addUtcMonths(t('2026-01-31T08:00:00Z'), 3))).toBe('2026-04-30T08:00:00.000Z')
  })
  it('rejects fractional months', () => {
    expect(() => addUtcMonths(0, 0.5)).toThrow()
  })
})

describe('addUtcYears', () => {
  it('clamps Feb 29 in non-leap target years', () => {
    expect(iso(addUtcYears(t('2028-02-29T06:30:00Z'), 1))).toBe('2029-02-28T06:30:00.000Z')
    expect(iso(addUtcYears(t('2028-02-29T06:30:00Z'), 10))).toBe('2038-02-28T06:30:00.000Z')
    expect(iso(addUtcYears(t('2028-02-29T06:30:00Z'), -4))).toBe('2024-02-29T06:30:00.000Z')
  })
  it('gives the +/- 1 calendar year default range, not 365 days, also across a leap day', () => {
    const now = t('2026-11-14T21:00:00Z')
    expect(iso(addUtcYears(now, -1))).toBe('2025-11-14T21:00:00.000Z')
    expect(iso(addUtcYears(now, 1))).toBe('2027-11-14T21:00:00.000Z')
    const leap = t('2028-02-29T06:30:00Z')
    expect(iso(addUtcYears(leap, -1))).toBe('2027-02-28T06:30:00.000Z')
    expect(iso(addUtcYears(leap, 1))).toBe('2029-02-28T06:30:00.000Z')
    // A year that spans 29 February 2028 has 366 days, not 365.
    expect(addUtcYears(t('2027-06-01T00:00:00Z'), 1) - t('2027-06-01T00:00:00Z')).toBe(366 * 86_400_000)
  })
})
