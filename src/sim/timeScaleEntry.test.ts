// Importing only the public entry point must install the TAI - UTC time scale before any calculation.
import { describe, expect, it } from 'vitest'
import { MakeTime } from 'astronomy-engine'
import { skyAt, TIME_SCALE_MODEL, LEAP_SECONDS_VALID_UNTIL_UTC } from './index'

describe('time scale through src/sim', () => {
  it('is installed by importing the public API, before the first sky calculation', () => {
    skyAt({ lat: 0, lon: 0 }, new Date('2026-11-14T00:00:00Z'))
    const t = MakeTime(new Date('2026-11-14T00:00:00Z'))
    expect((t.tt - t.ut) * 86400).toBeCloseTo(69.184, 6)
    expect(TIME_SCALE_MODEL).toContain('tai-utc')
    expect(LEAP_SECONDS_VALID_UNTIL_UTC).toBe('2027-06-28')
  })
})
