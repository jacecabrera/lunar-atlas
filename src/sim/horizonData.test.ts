import { afterEach, describe, expect, it } from 'vitest'
import { runtimeHorizon, requireHorizon, validateHorizonSamples, toRuntimeSite } from './horizonData'
import type { HorizonData, SerializableSite } from './horizonData'
import { horizonFromProfile } from '../physics/horizon'
import { Dem } from '../physics/dem'
import { setTerrain, horizonDataAt, horizonAt, horizonProfileAt } from './terrain'
import { windows } from './site'

const site = { lat: 0, lon: 0 }
const available = (elevationsDeg: number[], startAzimuthDeg = 0, stepDeg = 360 / elevationsDeg.length): HorizonData => ({
  status: 'available',
  site,
  samples: { elevationsDeg, startAzimuthDeg, stepDeg, angleUnit: 'deg' },
  source: { product: 'test grid', gridSpacingKm: 7.6, verticalAccuracyM: null, referenceRadiusKm: 1737.4, frame: 'test' },
  model: { maxRangeKm: 200, mastM: 0, rayStepKm: 3.8, observerElevationM: 0 },
})

describe('HorizonData', () => {
  it('survives JSON and rebuilds the same skyline as the runtime function', () => {
    const profile = Array.from({ length: 180 }, (_, i) => 5 * Math.sin((i * 2 * Math.PI) / 180) + 1) // 2 deg step
    const data = available(profile, 0, 2)
    const restored = JSON.parse(JSON.stringify(data)) as HorizonData
    expect(restored).toEqual(data)
    const a = runtimeHorizon(restored)!
    const b = horizonFromProfile(profile)
    for (let az = -30; az <= 400; az += 7.3) expect(a(az)).toBeCloseTo(b(az), 12)
  })

  it('honours a non-zero start azimuth', () => {
    // 4 samples, 90 deg apart, starting at 45 deg: values 10 at 45, 20 at 135, 30 at 225, 40 at 315
    const h = runtimeHorizon(available([10, 20, 30, 40], 45, 90))!
    expect(h(45)).toBeCloseTo(10)
    expect(h(90)).toBeCloseTo(15)
    expect(h(315)).toBeCloseTo(40)
    expect(h(0)).toBeCloseTo(25) // halfway between 40 (at 315) and 10 (at 405)
  })

  it('rejects samples that do not cover 360 deg or hold invalid values', () => {
    expect(validateHorizonSamples({ elevationsDeg: [0, 1, 2], startAzimuthDeg: 0, stepDeg: 90, angleUnit: 'deg' })).toHaveLength(1)
    expect(validateHorizonSamples({ elevationsDeg: [0, Number.NaN], startAzimuthDeg: 0, stepDeg: 180, angleUnit: 'deg' })).toHaveLength(1)
    expect(() => runtimeHorizon(available([0, 1, 2], 0, 90))).toThrow(/360/)
  })

  it('maps unavailable data to unknown and a failed service to error, never to a smooth sphere', () => {
    const missing: HorizonData = { status: 'unavailable', site, code: 'not-loaded', message: 'Terrain data has not been loaded' }
    const failed: HorizonData = { status: 'unavailable', site, code: 'service-error', message: 'Request failed' }
    expect(runtimeHorizon(missing)).toBeNull()
    const m = requireHorizon(missing)
    const f = requireHorizon(failed)
    expect(m.ok === false && m.condition.status).toBe('unknown')
    expect(m.ok === false && m.condition.reasons[0].code).toBe('horizon-not-loaded')
    expect(f.ok === false && f.condition.status).toBe('error')
    expect(requireHorizon(available([0, 0])).ok).toBe(true)
  })

  it('a serializable site rebuilds a runtime Site with the same visibility windows', () => {
    const ridge = Array.from({ length: 72 }, (_, i) => (i * 5 > 45 && i * 5 < 135 ? 20 : 0)) // 5 deg step
    const s: SerializableSite = { id: 'test', lat: 0, lon: 0, horizon: available(ridge, 0, 5) }
    const t0 = Date.UTC(2026, 10, 13)
    const t1 = t0 + 30 * 86_400_000
    const fromData = windows(toRuntimeSite(JSON.parse(JSON.stringify(s))), 'sun', t0, t1)
    const direct = windows({ lat: 0, lon: 0, horizon: horizonFromProfile(ridge) }, 'sun', t0, t1)
    expect(fromData).toEqual(direct)
    expect(toRuntimeSite({ ...s, horizon: null }).horizon).toBeUndefined()
  })
})

describe('terrain horizonDataAt', () => {
  afterEach(() => setTerrain(null))

  // Flat Moon with a 2 km wall 1.0-1.5 deg east of (0, 0), as in dem.test.ts
  const ppd = 4
  const makeDem = () => {
    const width = 360 * ppd
    const height = 180 * ppd
    const data = new Int16Array(width * height)
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const lon = (c + 0.5) / ppd
        data[r * width + c] = lon >= 1 && lon <= 1.5 ? 2000 : 0
      }
    }
    return new Dem({ width, height, ppd, radiusKm: 1737.4 }, data)
  }

  it('reports not-loaded instead of falling back to a sphere', () => {
    setTerrain(null)
    const d = horizonDataAt(0, 0)
    expect(d.status).toBe('unavailable')
    expect(d.status === 'unavailable' && d.code).toBe('not-loaded')
  })

  it('records sample spacing, source and model parameters, and matches horizonAt', () => {
    setTerrain(makeDem(), 'synthetic test grid')
    const opts = { azimuthStepDeg: 10, maxRangeKm: 100 }
    const d = horizonDataAt(0, 0, opts)
    expect(d.status).toBe('available')
    if (d.status !== 'available') return
    expect(d.samples.elevationsDeg).toHaveLength(36)
    expect(d.samples.stepDeg).toBe(10)
    expect(d.source.product).toBe('synthetic test grid')
    expect(d.source.gridSpacingKm).toBeCloseTo((1737.4 * Math.PI) / 180 / ppd, 9)
    expect(d.model).toMatchObject({ maxRangeKm: 100, mastM: 0, observerElevationM: 0 })
    const fn = horizonAt(0, 0, opts)
    const rebuilt = runtimeHorizon(d)!
    for (let az = 0; az < 360; az += 3.7) expect(rebuilt(az)).toBeCloseTo(fn(az), 12)
    expect(rebuilt(90)).toBeGreaterThan(2) // the wall to the east
  })

  it('rejects an azimuth step that does not divide 360 instead of mis-mapping samples', () => {
    setTerrain(makeDem())
    expect(() => horizonAt(0, 0, { azimuthStepDeg: 7, maxRangeKm: 50 })).toThrow(/divide 360/)
    expect(() => horizonProfileAt(0, 0, { azimuthStepDeg: 7, maxRangeKm: 50 })).toThrow(/divide 360/)
  })
})
