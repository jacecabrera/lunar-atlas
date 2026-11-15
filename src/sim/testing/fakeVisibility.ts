// Test helper: a SYNTHETIC visibility model driven by explicit functions. Margins must change no faster than the
// rate bounds of events.ts (Sun 0.6 deg/h, Earth 0.15 deg/h), or the event search may legitimately miss transitions.
import type { SunVisibility, EarthVisibility, VisibilityModel } from '../visibility'
import { SUN_VISIBILITY_POLICY, earthVisibilityPolicy } from '../assessment'
import { AU_KM } from '../../physics/coords'

export const H = 3_600_000
/** Margin ramp crossing 0 at t0 (rising if dir = 1), slope in deg/h, clamped to +/- 0.05 deg. */
export const ramp = (t0: number, dir: 1 | -1, degPerHour: number) => (t: number) => Math.max(-0.05, Math.min(0.05, (dir * degPerHour * (t - t0)) / H))

export function fakeVisibility(o: {
  /** Sun margin (> 0: sunlit); null = unknown. */
  sunMargin: (t: number) => number | null
  /** Visible disc fraction while sunlit (default 1). */
  fraction?: (t: number) => number
  /** Earth margin (> 0: visible); null = unknown. */
  earthMargin: (t: number) => number | null
  /** Sun azimuth/elevation (default due east on the horizon: east panel at normal incidence). */
  sunAz?: number; sunEl?: number
}): VisibilityModel {
  const sunAt = (t: number): SunVisibility => {
    const m = o.sunMargin(t)
    const f = m === null ? null : m > 0 ? (o.fraction?.(t) ?? 1) : 0
    return {
      tMs: t, geometry: { azimuthDeg: o.sunAz ?? 90, elevationDeg: o.sunEl ?? 0, angularRadiusDeg: 0.2666, distanceKm: AU_KM }, formal: true,
      terrainVisible: m === null ? null : m > 0, terrainVisibleFraction: f, earthOccultedFraction: 0, visibleFraction: f, visibleFractionUpperBound: null,
      sunlit: m === null ? null : m > 0, blockedBy: [], terrainMarginDeg: m, terrainClearanceDeg: m === null ? null : m - 0.54, earthSeparationDeg: 90, reasons: [],
    }
  }
  const earthAt = (t: number): EarthVisibility => {
    const m = o.earthMargin(t)
    return { tMs: t, geometry: { elevationDeg: 10, azimuthDeg: 180, angularRadiusDeg: 0.95, distanceKm: 384_400 }, formal: true, minElevationDeg: 0, skylineDeg: 0, skylineIsLowerBound: false, marginDeg: m, visible: m === null ? null : m > 0, reasons: [] }
  }
  return { status: 'ready', reasons: [], observerRadiusKm: 1737.4, observerRadiusSource: 'horizon-observer', policy: { sun: SUN_VISIBILITY_POLICY, earth: earthVisibilityPolicy(0) }, model: 'fake', sunAt, earthAt, skylineMaxSlope: 0, lowerBoundInAzimuths: () => false }
}
