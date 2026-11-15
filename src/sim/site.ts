// Site-level visibility queries. Moved out of index.ts so domain modules (power.ts, horizonData.ts) can depend on
// them without importing the public barrel, which removes the former power.ts <-> index.ts import cycle.
//
// Current behaviour, unchanged in step 03: both the Sun and Earth count as "up" while any part of the disc clears
// max(maskDeg, horizon). v0.7 requires the disc centre for Earth; that change belongs to step 09.
import { siteSky } from '../physics/siteSky'
import type { SkyBody } from '../physics/siteSky'
import { upIntervals, statusAt, summarize, intersect } from '../physics/siteTimeline'
import type { Interval, Target, VisibilityOptions } from '../physics/siteTimeline'
import type { Horizon } from '../physics/horizon'
import { horizonAt, terrainAt } from './terrain'
import { MOON_R_KM } from '../physics/siteSky'
import type { HorizonOptions } from './terrain'

/**
 * Runtime site. `horizon` absent = smooth sphere (geometric horizon). `radiusKm` is the observer's distance from the
 * Moon's centre (reference radius + ground elevation + observer height); absent = 1737.4 km. For transport use
 * SerializableSite.
 */
export type Site = { name?: string; lat: number; lon: number; horizon?: Horizon; radiusKm?: number }

// A Site at any coordinates with its LDEM_4 skyline attached (needs loadTerrain() first). The observer stands on the
// same DEM surface the skyline was cast from (before step 07 the sky used the bare 1737.4 km sphere instead).
// Regional preview quality only: no near field (see horizonDataAt / requireHorizon for formal use).
export function siteAt(lat: number, lon: number, opts: HorizonOptions & { name?: string } = {}): Site {
  const { name, ...horizonOpts } = opts
  const ground = terrainAt(lat, lon).elevationM
  return { name, lat, lon, horizon: horizonAt(lat, lon, horizonOpts), radiusKm: MOON_R_KM + (ground + (horizonOpts.mastM ?? 0)) / 1000 }
}

export type SkyState = { sun: SkyBody; earth: SkyBody; sunUp: boolean; earthUp: boolean }

// Where the Sun and Earth are at a site, and whether each is up (any part of the disc above the mask).
export function skyAt(site: Site, date: Date, opts: VisibilityOptions = {}): SkyState {
  const { sun, earth } = siteSky(site.lat, site.lon, date, opts.observerRadiusKm ?? site.radiusKm)
  const horizon = opts.horizon ?? site.horizon
  const up = (b: SkyBody) =>
    b.elevation + b.angularRadius - Math.max(opts.maskDeg ?? 0, horizon ? horizon(b.azimuth) : -Infinity) > 0
  return { sun, earth, sunUp: up(sun), earthUp: up(earth) }
}

export function windows(
  site: Site, target: Target, startMs: number, endMs: number,
  opts: VisibilityOptions & { stepMs?: number } = {},
): Interval[] {
  const { stepMs, ...vis } = opts
  return upIntervals(site.lat, site.lon, target, startMs, endMs, stepMs, { horizon: site.horizon, observerRadiusKm: site.radiusKm, ...vis })
}

// Next rise OR set after tMs (a rise when the body is down now). Not yet the v0.7 "next set" query (step 10).
export function nextEvent(site: Site, target: Target, tMs: number, opts: VisibilityOptions = {}) {
  return statusAt(site.lat, site.lon, target, tMs, undefined, { horizon: site.horizon, observerRadiusKm: site.radiusKm, ...opts })
}

// Side-by-side comparison over one window. `sunAndEarthVisible` = Sun up AND Earth up at the same time: geometry
// only. It does not mean the lander can operate, that power is sufficient, or that a radio link works.
// Each result has `intervals` (the up-windows) plus fractionUp, longestUpMs, longestDownMs and `windows` (a count).
export function compareSites(
  sites: Site[], startMs: number, endMs: number,
  opts: { sun?: VisibilityOptions; earth?: VisibilityOptions; stepMs?: number } = {},
) {
  return sites.map((site) => {
    const sun = windows(site, 'sun', startMs, endMs, { ...opts.sun, stepMs: opts.stepMs })
    const earth = windows(site, 'earth', startMs, endMs, { ...opts.earth, stepMs: opts.stepMs })
    const both = intersect(sun, earth)
    return {
      site,
      sun: { intervals: sun, ...summarize(sun, startMs, endMs) },
      earth: { intervals: earth, ...summarize(earth, startMs, endMs) },
      sunAndEarthVisible: { intervals: both, ...summarize(both, startMs, endMs) },
    }
  })
}

// Relative power on a flat panel that faces the Sun's azimuth, tilted `tiltDeg` up from horizontal
// (0 = lying flat, 90 = vertical). 1 = Sun square-on, 0 = no light. A geometric factor only:
// no shadowing, no panel efficiency, no solar-constant scaling. Not the fixed east/west panel model (step 11).
export function panelFactor(elevationDeg: number, tiltDeg = 0): number {
  return Math.max(0, Math.sin(((elevationDeg + tiltDeg) * Math.PI) / 180))
}
