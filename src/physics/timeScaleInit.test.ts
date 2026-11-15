// Documents why the time scale must be installed by import: this test file imports astronomy-engine alone, so (with
// Vitest's per-file module isolation) the library still uses its default Delta T polynomial here.
import { describe, expect, it } from 'vitest'
import { MakeTime } from 'astronomy-engine'

describe('astronomy-engine without the project time scale', () => {
  it('uses its extrapolated Delta T, which differs from TT - UTC by seconds', () => {
    const t = MakeTime(new Date('2026-11-14T00:00:00Z'))
    const deltaT = (t.tt - t.ut) * 86400
    expect(Math.abs(deltaT - 69.184)).toBeGreaterThan(3)
  })
})
