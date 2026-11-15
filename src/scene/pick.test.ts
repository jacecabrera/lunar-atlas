// Picking with real three.js objects posed like the scene (no WebGL needed).
import { describe, expect, it } from 'vitest'
import { Group, Matrix4, Mesh, MeshBasicMaterial, Raycaster, SphereGeometry, Vector3 } from 'three'
import { pickMoon } from './pick'
import { latLonToMoonLocal } from './moonPicking'
import { sceneState, SCENE_RADII } from '../sim/scene'

function posedMoon(t: Date, parent?: Group, scale = 1) {
  const g = new Group()
  g.scale.setScalar(scale) // the size switch scales the Moon group (display only)
  const s = sceneState(t)
  g.position.set(...s.moonPosition)
  const R = s.moonRotation
  g.quaternion.setFromRotationMatrix(new Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1))
  const moon = new Mesh(new SphereGeometry(SCENE_RADII.moon, 128, 128), new MeshBasicMaterial())
  moon.name = 'moon'
  g.add(moon)
  if (parent) parent.add(g)
  return { group: g, moon }
}
/** A ray from outside straight down onto a known surface point. */
function rayOnto(moon: Mesh, lat: number, lon: number, from = 10) {
  moon.updateWorldMatrix(true, false)
  const surface = moon.localToWorld(new Vector3(...latLonToMoonLocal(lat, lon, SCENE_RADII.moon)))
  const centre = moon.localToWorld(new Vector3(0, 0, 0))
  const dir = surface.clone().sub(centre).normalize()
  return new Raycaster(surface.clone().addScaledVector(dir, from), dir.clone().negate())
}

describe('pickMoon', () => {
  it('recovers the same coordinates when the Moon is drawn 10x larger (the display scale is inverted by worldToLocal)', () => {
    for (const k of [1, 10]) {
      const { moon } = posedMoon(new Date(Date.UTC(2027, 2, 1, 6)), undefined, k)
      for (const [lat, lon] of [[0.674, 23.473], [-45.456, 177.589], [89.99, 45], [10, -179.999]]) {
        const hit = pickMoon(rayOnto(moon, lat, lon, 40), [moon], moon)!
        expect(hit.lat).toBeCloseTo(lat, 4)
        expect(Math.abs(((hit.lon - lon + 540) % 360) - 180)).toBeLessThan(1e-3)
      }
    }
  })
  it('recovers known coordinates at different simulation times (the Moon rotates and moves)', () => {
    for (const t of [Date.UTC(2026, 10, 15), Date.UTC(2027, 2, 1, 6), Date.UTC(2027, 7, 20, 18)]) {
      const { moon } = posedMoon(new Date(t))
      for (const [lat, lon] of [[0.674, 23.473], [-45.456, 177.589], [20.19, -30.77], [10, 179.999], [10, -179.999], [89.99, 45], [-89.99, -120]]) {
        const hit = pickMoon(rayOnto(moon, lat, lon), [moon], moon)!
        expect(hit.lat).toBeCloseTo(lat, 4)
        // Across the seam, compare on the circle.
        expect(Math.abs(((hit.lon - lon + 540) % 360) - 180)).toBeLessThan(1e-4 / Math.max(1e-3, Math.cos((lat * Math.PI) / 180)))
      }
    }
  })
  it('handles parent translation, rotation and scale through worldToLocal', () => {
    const root = new Group()
    root.position.set(1000, -50, 20)
    root.rotation.set(0.3, -1.1, 0.7)
    root.scale.setScalar(2.5)
    const { moon } = posedMoon(new Date(Date.UTC(2027, 0, 1)), root)
    const hit = pickMoon(rayOnto(moon, -69.374, 32.32, 40), [moon], moon)!
    expect(hit.lat).toBeCloseTo(-69.374, 4)
    expect(hit.lon).toBeCloseTo(32.32, 4)
  })
  it('does not pick the Moon through a body in front of it, and misses return null', () => {
    const { moon } = posedMoon(new Date(Date.UTC(2027, 0, 1)))
    const ray = rayOnto(moon, 0, 0, 30)
    const blocker = new Mesh(new SphereGeometry(2, 32, 32), new MeshBasicMaterial())
    blocker.name = 'earth'
    blocker.position.copy(ray.ray.origin).addScaledVector(ray.ray.direction, 10)
    expect(pickMoon(ray, [blocker, moon], moon)).toBeNull()
    const away = new Raycaster(ray.ray.origin.clone(), ray.ray.direction.clone().negate())
    expect(pickMoon(away, [moon], moon)).toBeNull()
  })
})
