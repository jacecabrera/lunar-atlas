// Scene geometry: true scale, Sun placement, texture orientation, and the lat/lon <-> scene transforms for picking.
import { describe, expect, it } from 'vitest'
import { SphereGeometry } from 'three'
import { latLonToMoonLocal, moonLocalToLatLon, moonLocalToScene, sceneToMoonLocal } from './moonPicking'
import { sceneState, SCENE_RADII, sunDirection } from '../sim/scene'
import { moonSitePositionEqjKm } from '../physics/moonFrame'
import { toScene, UNIT_KM } from '../physics/coords'
import { MOON_R_KM, EARTH_R_KM, SUN_R_KM } from '../physics/siteSky'
import { publicUrl } from './assets'

const T = new Date(Date.UTC(2027, 2, 1, 6))

describe('surface coordinates', () => {
  it('round-trips latitude and longitude, with the seam at +180 and longitude 0 at the poles', () => {
    for (const lat of [-89.5, -45, 0, 30.25, 89.5]) for (const lon of [-179.9, -90, 0, 23.473, 135, 179.99]) {
      const v = latLonToMoonLocal(lat, lon, SCENE_RADII.moon)
      const back = moonLocalToLatLon(...v)
      expect(back.lat).toBeCloseTo(lat, 9)
      expect(back.lon).toBeCloseTo(lon, 9)
    }
    expect(moonLocalToLatLon(...latLonToMoonLocal(10, -180, 1)).lon).toBeCloseTo(180, 9) // -180 and 180 are one meridian
    expect(moonLocalToLatLon(...latLonToMoonLocal(10, 180, 1)).lon).toBeCloseTo(180, 9)
    expect(moonLocalToLatLon(0, 1, 0)).toEqual({ lat: 90, lon: 0 })
    expect(moonLocalToLatLon(0, -2, 0)).toEqual({ lat: -90, lon: 0 })
    expect(() => moonLocalToLatLon(0, 0, 0)).toThrow(RangeError)
  })
  it('places a surface point where the physics puts it (render pose = calculation pose)', () => {
    const s = sceneState(T)
    for (const [lat, lon] of [[0.674, 23.473], [-69.374, 32.32], [-45.456, 177.589], [26.13, 3.63]]) {
      const local = latLonToMoonLocal(lat, lon, MOON_R_KM / UNIT_KM)
      const scene = moonLocalToScene(s, local)
      const physics = toScene({ x: 0, y: 0, z: 0, ...Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, moonSitePositionEqjKm(lat, lon, MOON_R_KM, T)[i]])) } as { x: number; y: number; z: number }, 1 / UNIT_KM)
      for (let i = 0; i < 3; i++) expect(scene[i]).toBeCloseTo(physics[i], 6) // 1e-6 units = 1 m
      const back = moonLocalToLatLon(...sceneToMoonLocal(s, scene))
      expect(back.lat).toBeCloseTo(lat, 9)
      expect(back.lon).toBeCloseTo(lon, 9)
    }
  })
})

describe('true scale and the Sun', () => {
  it('uses the calculation radii and the ephemeris distances (no enlargement)', () => {
    expect(SCENE_RADII).toEqual({ moon: MOON_R_KM / 1000, earth: EARTH_R_KM / 1000, sun: SUN_R_KM / 1000 })
    const s = sceneState(T)
    const ratio = Math.hypot(...s.moonPosition) / SCENE_RADII.moon
    expect(ratio).toBeGreaterThan(356_000 / 1737.4)
    expect(ratio).toBeLessThan(407_000 / 1737.4)
  })
  it('puts the Sun at its ephemeris position: direction, distance and angular size', () => {
    const s = sceneState(T)
    const d = Math.hypot(...s.sunPosition)
    expect(d * UNIT_KM / 149_597_870.7).toBeGreaterThan(0.98)
    expect(d * UNIT_KM / 149_597_870.7).toBeLessThan(1.02)
    const dir = sunDirection(T)
    s.sunPosition.forEach((x, i) => expect(x / d).toBeCloseTo(dir[i], 12))
    const angDeg = (Math.asin(SCENE_RADII.sun / d) * 180) / Math.PI
    expect(angDeg).toBeGreaterThan(0.26)
    expect(angDeg).toBeLessThan(0.275)
  })
})

describe('texture orientation', () => {
  it('three.js sphere UVs match the convention: image centre = lon 0 (+X), right of centre = east (-Z), top = north', () => {
    const g = new SphereGeometry(1, 64, 32)
    const pos = g.attributes.position, uv = g.attributes.uv
    const at = (u: number, v: number) => {
      for (let i = 0; i < uv.count; i++) if (Math.abs(uv.getX(i) - u) < 1e-6 && Math.abs(uv.getY(i) - v) < 1e-6) return [pos.getX(i), pos.getY(i), pos.getZ(i)]
      throw new Error('vertex not found')
    }
    const c = at(0.5, 0.5), e = at(0.75, 0.5)
    let n = [0, 0, 0]
    for (let i = 0; i < uv.count; i++) if (Math.abs(uv.getY(i) - 1) < 1e-9) { n = [pos.getX(i), pos.getY(i), pos.getZ(i)]; break } // pole row (u offset by half a cell)
    expect(c[0]).toBeCloseTo(1, 9) // lon 0
    expect(e[2]).toBeCloseTo(-1, 9) // lon 90 E
    expect(n[1]).toBeCloseTo(1, 9) // north pole
    expect(latLonToMoonLocal(0, 90, 1)[2]).toBeCloseTo(-1, 12) // the same convention in the transforms
  })
  it('builds public URLs from the deployment base', () => {
    expect(publicUrl('textures/moon.jpg')).toBe(`${import.meta.env.BASE_URL}textures/moon.jpg`)
  })
})

describe('no display parameters leak into the calculations', () => {
  it('calculation modules never import the scene, the display store or the clock', () => {
    const files = import.meta.glob(['../sim/**/*.ts', '../physics/**/*.ts', '!../**/*.test.ts'], { query: '?raw', eager: true, import: 'default' }) as Record<string, string>
    expect(Object.keys(files).length).toBeGreaterThan(30)
    for (const [path, src] of Object.entries(files)) {
      expect(src, path).not.toMatch(/from '(\.\.\/)+(scene|state|ui|time)\//)
      expect(src, path).not.toMatch(/appStore|timeStore/)
    }
  })
})
