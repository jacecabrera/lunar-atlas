// PV model tests. Sun states are SYNTHETIC (built by hand) except where the real visibility model is named.
import { describe, expect, it } from 'vitest'
import { SearchLunarEclipse } from 'astronomy-engine'
import { panelNormal, pvFromSun, pvPowerAt } from './pv'
import type { PvSettings } from './pv'
import type { SunVisibility, VisibilityModel } from './visibility'
import { visibilityModel } from './visibility'
import { defaultAdvancedSettings } from './defaults'
import { AU_KM } from '../physics/coords'
import type { HorizonData } from './horizonData'

const settings = defaultAdvancedSettings() // east/west 0.54 x 0.54 m, tilt 90, eta 0.30, 100 W limit, 1361 W/m2, k_loss 1
const S: PvSettings = { device: settings.device, model: settings.model }
const A = 0.54 * 0.54
const sun = (az: number, el: number, f: number | null, over: Partial<SunVisibility> = {}): SunVisibility => ({
  tMs: 0, geometry: { azimuthDeg: az, elevationDeg: el, angularRadiusDeg: 0.2666, distanceKm: AU_KM }, formal: true,
  terrainVisible: f === null ? null : f > 0, terrainVisibleFraction: f, earthOccultedFraction: 0, visibleFraction: f, visibleFractionUpperBound: null,
  sunlit: f === null ? null : f > 0, blockedBy: [], terrainMarginDeg: 1, terrainClearanceDeg: 1, earthSeparationDeg: 90, reasons: [], ...over,
})
const P = (f: number, cos: number, area = A) => 1361 * 0.3 * area * cos * f

describe('panel geometry', () => {
  it('uses the configured panels: east and west, 0.2916 m2 each, vertical', () => {
    expect(settings.device.panels.map((p) => [p.id, p.azimuthDeg, p.tiltDeg])).toEqual([['east', 90, 90], ['west', 270, 90]])
    expect(settings.device.panels[0].areaM2).toBeCloseTo(A, 12)
    const e = panelNormal(settings.device.panels[0]), w = panelNormal(settings.device.panels[1])
    expect(e[0]).toBeCloseTo(1, 12)
    expect(w[0]).toBeCloseTo(-1, 12)
    expect(panelNormal({ azimuthDeg: 0, tiltDeg: 0 })[2]).toBeCloseTo(1, 12) // tilt from horizontal: 0 faces the zenith
  })
  it('front, back and grazing incidence; the two panels never both face the Sun', () => {
    const east = pvFromSun(sun(90, 0, 0.1), S)
    expect(east.panels[0].incidenceCos).toBeCloseTo(1, 12)
    expect(east.panels[1].incidenceCos).toBe(0) // back side: no output
    expect(east.powerW).toBeCloseTo(P(0.1, 1), 9)
    const oblique = pvFromSun(sun(135, 30, 0.1), S)
    expect(oblique.panels[0].incidenceCos).toBeCloseTo(Math.cos(Math.PI / 6) * Math.sin((3 * Math.PI) / 4), 12)
    expect(oblique.panels[1].incidenceCos).toBe(0)
    const north = pvFromSun(sun(0, 10, null), S) // Sun in the panels' planes
    expect(north).toMatchObject({ status: 'determined', powerW: 0 }) // 0 W even with an unknown fraction
    expect(pvFromSun(sun(270, 89.9, 1), S).powerW).toBeLessThan(1) // near the zenith: almost edge-on to both
  })
})

describe('irradiance, visible fraction and limits', () => {
  it('scales with the inverse square of the Sun distance', () => {
    const near = pvFromSun(sun(90, 0, 0.1, { geometry: { azimuthDeg: 90, elevationDeg: 0, angularRadiusDeg: 0.27, distanceKm: 0.983 * AU_KM } }), S)
    expect(near.irradianceWm2!).toBeCloseTo(1361 / 0.983 ** 2, 9)
    expect(near.powerW!).toBeCloseTo(P(0.1, 1) / 0.983 ** 2, 9)
  })
  it('is proportional to the visible fraction below the limit; the visible fraction is not an efficiency', () => {
    expect(pvFromSun(sun(90, 0, 0.4), S).powerW!).toBeCloseTo(4 * pvFromSun(sun(90, 0, 0.1), S).powerW!, 9)
    expect(pvFromSun(sun(90, 0, 0), S).powerW).toBe(0)
  })
  it('caps the whole array at the controller limit, not each panel; 100 W is never multiplied in', () => {
    const full = pvFromSun(sun(90, 0, 1), S)
    expect(full.rawW!).toBeCloseTo(P(1, 1), 9) // 119.06 W from area, efficiency and irradiance alone
    expect(full).toMatchObject({ powerW: 100, limited: true })
    // Two east-facing panels at 60 W each: 120 W raw, 100 W out (a per-panel cap would allow 120 W).
    const twin: PvSettings = { ...S, device: { ...S.device, panels: [{ id: 'a', areaM2: 60 / (1361 * 0.3), azimuthDeg: 90, tiltDeg: 90 }, { id: 'b', areaM2: 60 / (1361 * 0.3), azimuthDeg: 90, tiltDeg: 90 }] } }
    expect(pvFromSun(sun(90, 0, 1), twin).powerW).toBe(100)
  })
  it('k_loss scales the output', () => {
    expect(pvFromSun(sun(90, 0, 0.1), { ...S, model: { ...S.model, lossFactor: 0.5 } }).powerW!).toBeCloseTo(P(0.1, 1) * 0.5, 9)
  })
})

describe('unknown, error and invalid input', () => {
  it('an unknown fraction gives bounds, never a number from a binary sun-up', () => {
    const b = pvFromSun(sun(90, 0, null, { visibleFractionUpperBound: 0.3, earthOccultedFraction: 0.2 }), S)
    expect(b).toMatchObject({ status: 'bounded', powerW: null, lowerW: 0 })
    expect(b.upperW!).toBeCloseTo(Math.min(P(0.3, 1), 100), 9)
    const c = pvFromSun(sun(90, 0, null, { earthOccultedFraction: 0.6 }), S)
    expect(c.upperW!).toBeCloseTo(P(0.4, 1), 9) // no stated upper bound: 1 - known Earth cover
  })
  it('a failing visibility model gives error; invalid settings throw', () => {
    const broken = { sunAt: () => { throw new Error('ephemeris failure') } } as unknown as VisibilityModel
    expect(pvPowerAt(broken, S, 0)).toMatchObject({ status: 'error', powerW: null, lowerW: null })
    expect(() => pvFromSun(sun(90, 0, 1), { ...S, device: { ...S.device, pvEfficiency: 0 } })).toThrow(RangeError)
    expect(() => pvFromSun(sun(90, 0, 1), { ...S, device: { ...S.device, panels: [] } })).toThrow(RangeError)
    expect(() => pvFromSun(sun(90, 0, 1), { ...S, device: { ...S.device, panels: [{ id: 'x', areaM2: 1, azimuthDeg: 0, tiltDeg: 120 }] } })).toThrow(RangeError)
  })
})

describe('formal entry with the real visibility model', () => {
  const flat = (lat: number, lon: number, sky: number): HorizonData => {
    const az = Array.from({ length: 720 }, (_, i) => i * 0.5)
    return {
      status: 'available', site: { lat, lon }, samples: { elevationsDeg: az.map(() => sky), startAzimuthDeg: 0, stepDeg: 0.5, angleUnit: 'deg' },
      source: { product: 'synthetic', gridSpacingKm: 0.002, verticalAccuracyM: null, referenceRadiusKm: 1737.4, frame: 'synthetic' }, model: { maxRangeKm: 200, mastM: 0, rayStepKm: 0.001, observerElevationM: 0 },
      observer: { elevationM: 0, elevationSource: 's', elevationQuality: 'measured', observerHeightM: 0, radiusKm: 1737.4 },
      coverage: { searchRangeKm: 200, nearStartKm: 0.02, complete: true, nearField: 'screened', sampleStatus: az.map(() => 'complete'), coveredToKm: az.map(() => 200), governingKm: az.map(() => 1), governingSource: az.map(() => 's'), uncertaintyDeg: az.map(() => null), fallbackSamples: 0, skippedSamples: 0, lowerBoundAzimuths: 0 },
      quality: { nearFieldSelection: { productId: 's', tier: 'all gates', degraded: false }, convergence: { status: 'within-tolerance', toleranceDeg: 0.05, checks: [] } },
    }
  }
  it('uses the joint terrain and Earth visible fraction during a lunar eclipse', () => {
    const peak = SearchLunarEclipse(new Date('2025-03-01T00:00:00Z')).peak.date.getTime()
    const site = { lat: 0, lon: 80 }
    const m = visibilityModel({ ...site, horizon: flat(site.lat, site.lon, -5) }, { earthMinElevationDeg: 0 })
    expect(pvPowerAt(m, S, peak).powerW).toBe(0) // total eclipse: no output although the Sun is above the terrain
    for (let k = 1; k <= 80; k++) {
      const t = peak - k * 3 * 60_000, s = m.sunAt(t), p = pvPowerAt(m, S, t)
      if (s.earthOccultedFraction > 0.2 && s.earthOccultedFraction < 0.8) {
        const clear = p.panels.reduce((a, x) => a + x.rawUpperW, 0)
        expect(p.rawW!).toBeCloseTo(clear * s.visibleFraction!, 9)
        return
      }
    }
    throw new Error('no partial phase found')
  })
  it('without a formal horizon the output is only bounded (no smooth-sphere or binary fallback)', () => {
    const m = visibilityModel({ lat: 0, lon: 80, horizon: null }, { earthMinElevationDeg: 0 })
    const p = pvPowerAt(m, S, Date.UTC(2026, 10, 20, 12))
    expect(['bounded', 'determined']).toContain(p.status)
    if (p.status === 'bounded') expect(p.lowerW).toBe(0)
  })
})
