// Step 06 wrap-up: (1) separate lunar orientation from our ephemeris, (2) check fixed, use-specific budgets on a holdout
// set that played no part in choosing them. Budgets (fixed before the holdout was fetched; docs/step-06-frames-and-ephemeris.md):
//   sky direction seen from a lunar site (Sun, Earth)            0.01 deg
//   site-Earth distance (Earth angular radius error <= 0.001 deg) 400 km
//   site-Sun distance (irradiance error < 0.02 %)                 10,000 km
//   Moon centre, for directions (0.01 deg x 384,400 km)          67 km
//   transit endpoint distance, as time at 1.5 km/s (<= 1 min)     90 km = 60 s
//   Earth surface site                                           1 km
//   lunar orientation IAU vs DE421 mean Earth (orientation only)  0.01 deg
// Every value from our side comes from the formal entry points: siteSky (skyAt), moonSiteGeocentric,
// earthSiteGeocentric, separationKm, eqjToMoonFixed.
import { describe, expect, it } from 'vitest'
import { Body, HelioVector, KM_PER_AU } from 'astronomy-engine'
import first from './reference/horizons-step06.json'
import holdout from './reference/horizons-step06-holdout.json'
import { apply, eqjToMoonFixed } from './moonFrame'
import { siteSky } from './siteSky'
import { moonSiteGeocentric, earthSiteGeocentric, separationKm } from '../sim/frames'
import type { Vec3 } from './moonFrame'
import {
  add, angleDeg, cells, enu, fromLatLon, jdToMs, km, max, norm, parseCal, rotationAngleDeg, scale, sub, triad, unit,
  velocitiesKmS, C_KM_S,
} from './horizonsTestUtils'

type Table = { data: string[] }

/**
 * Orientation only: sub-solar and sub-Earth directions built from Horizons' own geometric vectors and light time,
 * rotated with our IAU orientation, then compared with Horizons' MOON_ME sub-points. Our ephemeris drops out; the
 * light-time terms use library velocities (a ~20 arcsec correction known to much better than 0.01 arcsec).
 */
function orientationOnly(set: { geocentric: { moon: Table; sun: Table }; subPoints: Table }) {
  const moon = set.geocentric.moon.data.map(cells).map((c) => [Number(c[2]), Number(c[3]), Number(c[4])] as Vec3)
  const sun = set.geocentric.sun.data.map(cells).map((c) => [Number(c[2]), Number(c[3]), Number(c[4])] as Vec3)
  return set.subPoints.data.map(cells).map((c, i) => {
    const ms = parseCal(c[0])
    const ltS = Number(c[9]) * 60 // Horizons one-way down-leg light time, minutes
    const t1 = new Date(ms - ltS * 1000)
    const v = velocitiesKmS(new Date(ms))
    // Moon at t - lt (geocentric), Earth at t, in the barycentric frame:
    // Earth(t) - Moon(t1) = [Earth(t) - Earth(t1)] - MoonGeo(t1) = vEarth * lt - MoonGeo(t1)
    const moonT1 = sub(moon[i], scale(v.moonGeo, ltS))
    const toEarth = add(scale(moonT1, -1), scale(v.earthBary, ltS))
    // Sun relative to the Moon at t1; the Sun's own motion over the light times is a few km (negligible).
    const toSun = sub(sun[i], moonT1)
    const M = eqjToMoonFixed(t1)
    const ours = { obs: unit(apply(M, toEarth)), sun: unit(apply(M, toSun)) }
    const ref = { obs: fromLatLon(Number(c[4]), Number(c[3])), sun: fromLatLon(Number(c[6]), Number(c[5])) }
    return { ms, ours, ref, sep: angleDeg(ref.sun, ref.obs) }
  })
}

describe('lunar orientation alone (ephemeris removed): IAU 2009 vs Horizons MOON_ME', () => {
  for (const [name, set] of [['first set', first], ['holdout', holdout]] as const) {
    it(`${name}: sub-solar and sub-Earth directions and the implied rotation stay within 0.01 deg`, () => {
      const rows = orientationOnly(set)
      const dSun = rows.map((r) => angleDeg(r.ours.sun, r.ref.sun))
      const dObs = rows.map((r) => angleDeg(r.ours.obs, r.ref.obs))
      const usable = rows.filter((r) => r.sep > 30 && r.sep < 150)
      const rot = usable.map((r) => rotationAngleDeg(triad(r.ours.sun, r.ours.obs, r.ref.sun, r.ref.obs)))
      console.log(`${name}: orientation-only sub-solar max ${(max(dSun) * 3600).toFixed(1)}", sub-Earth max ${(max(dObs) * 3600).toFixed(1)}"; rotation over ${usable.length} well-conditioned epochs ${(Math.min(...rot) * 3600).toFixed(1)}-${(max(rot) * 3600).toFixed(1)}"`)
      expect(max(dSun)).toBeLessThan(0.01)
      expect(max(dObs)).toBeLessThan(0.01)
      // TRIAD needs well-separated directions; the holdout epochs cluster near syzygies (four eclipses), so it has
      // fewer. The per-direction checks above cover every epoch in both sets.
      expect(usable.length).toBeGreaterThanOrEqual(name === 'holdout' ? 1 : 10)
      expect(max(rot)).toBeLessThan(0.01)
    })
  }
})

// Light-time range |target(t - lt) - site(t)| from heliocentric vectors, as Horizons reports "delta".
function apparentRangeKm(lat: number, lon: number, body: 'sun' | 'earth', ms: number): number {
  const t = new Date(ms)
  const site = moonSiteGeocentric({ lat, lon }, ms).positionKm
  const siteHelio = add(km(HelioVector(Body.Earth, t)), site)
  let lt = 0
  let d = 0
  for (let i = 0; i < 4; i++) {
    const target: Vec3 = body === 'sun' ? [0, 0, 0] : km(HelioVector(Body.Earth, new Date(ms - lt * 1000)))
    d = norm(sub(target, siteHelio))
    lt = d / C_KM_S
  }
  return d
}

describe('holdout: sky directions and distances from new lunar sites', () => {
  const rows = holdout.lunarSites.flatMap((s) => (['sun', 'earth'] as const).flatMap((body) =>
    s.tables[body].data.map(cells).map((c) => {
      const ms = parseCal(c[0])
      const sky = siteSky(s.lat, s.lon, new Date(ms))[body]
      return {
        body,
        sep: angleDeg(enu(sky.azimuth, sky.elevation), enu(Number(c[3]), Number(c[4]))),
        dEl: Math.abs(sky.elevation - Number(c[4])),
        dRange: Math.abs(apparentRangeKm(s.lat, s.lon, body, ms) - Number(c[5]) * KM_PER_AU),
      }
    })))

  it('covers 7 new sites x 2 bodies x 4 new epochs', () => {
    expect(rows).toHaveLength(56)
  })
  it('directions within 0.01 deg', () => {
    for (const body of ['sun', 'earth'] as const) {
      const xs = rows.filter((r) => r.body === body)
      console.log(`holdout ${body}: max direction ${(max(xs.map((x) => x.sep)) * 3600).toFixed(1)}", max elevation ${(max(xs.map((x) => x.dEl)) * 3600).toFixed(1)}"`)
      expect(max(xs.map((x) => x.sep))).toBeLessThan(0.01)
      expect(max(xs.map((x) => x.dEl))).toBeLessThan(0.01)
    }
  })
  it('distances: Earth within 400 km, Sun within 10,000 km', () => {
    const e = rows.filter((r) => r.body === 'earth').map((r) => r.dRange)
    const s = rows.filter((r) => r.body === 'sun').map((r) => r.dRange)
    console.log(`holdout range: Earth max ${max(e).toFixed(2)} km, Sun max ${max(s).toFixed(0)} km`)
    expect(max(e)).toBeLessThan(400)
    expect(max(s)).toBeLessThan(10_000)
  })
})

describe('holdout: Moon centre and transit endpoints', () => {
  it('Moon centre within 67 km (direction budget) at 12 new epochs', () => {
    const errs = holdout.geocentric.moon.data.map(cells).map((c) => {
      const ms = jdToMs(Number(c[0]))
      const ours = moonSiteGeocentric({ lat: 0, lon: 0, radiusKm: 1e-9 }, ms).positionKm // centre through the formal entry
      return norm(sub(ours, [Number(c[2]), Number(c[3]), Number(c[4])]))
    })
    console.log(`holdout Moon centre: max ${max(errs).toFixed(2)} km, mean ${(errs.reduce((a, b) => a + b) / errs.length).toFixed(2)} km`)
    expect(errs).toHaveLength(12)
    expect(max(errs)).toBeLessThan(67)
  })

  it('endpoint distance error, as transit time at 1.5 km/s, within 60 s; Earth sites within 1 km', () => {
    const SPEED = 1.5
    const moonRef = holdout.transitMoon.map((s) => ({ s, v: s.table.data.map(cells).map((c) => ({ ms: jdToMs(Number(c[0])), p: scale([Number(c[2]), Number(c[3]), Number(c[4])], -1) as Vec3 })) }))
    const earthRef = holdout.transitEarth.map((s) => ({ s, v: s.table.data.map(cells).map((c) => ({ ms: jdToMs(Number(c[0])), p: scale([Number(c[2]), Number(c[3]), Number(c[4])], -1) as Vec3 })) }))
    const dt: number[] = []
    const earthErr: number[] = []
    for (let k = 0; k < holdout.landings.length; k++) {
      for (const m of moonRef) {
        for (const e of earthRef) {
          const landing = moonSiteGeocentric({ lat: m.s.lat, lon: m.s.lon }, m.v[k].ms)
          const launch = earthSiteGeocentric({ lat: e.s.lat, lon: e.s.lon, heightM: e.s.altKm * 1000 }, e.v[k].ms)
          earthErr.push(norm(sub(launch.positionKm, e.v[k].p)))
          const dOurs = separationKm(launch, landing)
          const dRef = norm(sub(m.v[k].p, e.v[k].p))
          dt.push(Math.abs(dOurs - dRef) / SPEED)
        }
      }
    }
    console.log(`holdout transit: ${dt.length} pairs, max endpoint-distance effect ${max(dt).toFixed(1)} s; Earth site max ${max(earthErr).toFixed(3)} km`)
    expect(dt).toHaveLength(36)
    expect(max(dt)).toBeLessThan(60)
    expect(max(earthErr)).toBeLessThan(1)
  })
})
