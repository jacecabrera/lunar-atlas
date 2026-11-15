// Formal Sun and Earth visibility at a lunar site (v0.7 section 7; step 03 policies SUN_VISIBILITY_POLICY and
// earthVisibilityPolicy).
//
// Sun:   terrain-geometric visibility = some of the solar disc (positive area) above the terrain skyline. The skyline
//        may be negative; there is no minimum elevation. A visible limb is not full sunlight: visibleFraction gives the
//        part of the disc that is above the skyline and not covered by the Earth (lunar eclipse seen from the site).
// Earth: the disc centre must be strictly above max(terrain skyline, minimum elevation). Default minimum 0 deg, so a
//        negative skyline does not give the Earth centre visibility below 0 deg.
// No refraction (no lunar atmosphere). Geometric vectors, IAU orientation and the time scale of step 06.
//
// Unknown stays null. The model is 'ready' only with a horizon that passes requireHorizon (lower-bound azimuths are
// handled per instant); otherwise it still returns the geometry but no visibility verdict, except where the verdict
// does not depend on terrain (Earth centre below the minimum elevation; Sun fully behind the Earth).
import { siteSky, MOON_R_KM } from '../physics/siteSky'
import { discFraction, discTopMarginDeg, lowerBoundInSpan, skylineAt, skylineMaxSlope, tangentOffsetDeg } from '../physics/discVisibility'
import type { SkylineProfile } from '../physics/discVisibility'
import { requireHorizon } from './horizonData'
import type { HorizonData } from './horizonData'
import { SUN_VISIBILITY_POLICY, earthVisibilityPolicy } from './assessment'
import type { ConditionReason, EarthVisibilityPolicy, SunVisibilityPolicy } from './assessment'

export const VISIBILITY_MODEL =
  'visibility-v2:sun=disc-area-above-terrain(no-min-elevation;96-slice)+earth-occultation(sphere-6378.137km;no-atmosphere);earth=centre>max(terrain,min-elevation);lower-bound-aware'

export type BodyGeometry = { elevationDeg: number; azimuthDeg: number; angularRadiusDeg: number; distanceKm: number }

export type SunVisibility = {
  tMs: number
  geometry: BodyGeometry
  /** True when the verdict comes from a horizon that passed the formal gate. */
  formal: boolean
  /** Some of the disc above the terrain skyline (Earth ignored). */
  terrainVisible: boolean | null
  terrainVisibleFraction: number | null
  /** Fraction of the disc behind the Earth: geometry only, always known. */
  earthOccultedFraction: number
  /** Fraction above the skyline and outside the Earth's disc, 0..1. Not panel power: no incidence angle or efficiency. */
  visibleFraction: number | null
  /** When a lower-bound skyline sample is involved: the fraction cannot exceed this. */
  visibleFractionUpperBound: number | null
  /** Effective sunlight: some of the disc visible after terrain and Earth. */
  sunlit: boolean | null
  /** What hides part or all of the disc, where known. */
  blockedBy: Array<'terrain' | 'earth'>
  /**
   * Continuous margins for event searches (added for step 10). terrainMarginDeg: highest point of the disc's upper
   * edge above the skyline (> 0 iff terrainVisible when no lower bound is involved; with a lower bound it is an upper
   * bound on the true margin). terrainClearanceDeg: disc bottom minus the highest skyline sample under the disc
   * (> 0: wholly above the terrain). earthSeparationDeg: angle between the Sun and Earth centres.
   * Null without a usable horizon.
   */
  terrainMarginDeg: number | null
  terrainClearanceDeg: number | null
  earthSeparationDeg: number
  reasons: ConditionReason[]
}

export type EarthVisibility = {
  tMs: number
  geometry: BodyGeometry
  formal: boolean
  minElevationDeg: number
  /** Skyline at the Earth centre's azimuth; null without a usable horizon. */
  skylineDeg: number | null
  skylineIsLowerBound: boolean
  /**
   * Centre elevation minus max(skyline, minimum elevation), deg; null without a usable horizon (except below the
   * minimum elevation). Over a lower-bound sample it is an upper bound on the true margin.
   */
  marginDeg: number | null
  visible: boolean | null
  reasons: ConditionReason[]
}

export type VisibilityModel = {
  status: 'ready' | 'unavailable'
  /** Why the model is unavailable (from requireHorizon), empty when ready. */
  reasons: ConditionReason[]
  observerRadiusKm: number
  observerRadiusSource: 'horizon-observer' | 'reference-sphere'
  policy: { sun: SunVisibilityPolicy; earth: EarthVisibilityPolicy }
  model: string
  sunAt(tMs: number): SunVisibility
  earthAt(tMs: number): EarthVisibility
  /** Largest skyline slope (deg per deg of azimuth), for rate bounds in event searches; null without a horizon. */
  skylineMaxSlope: number | null
  /** Whether a lower-bound skyline sample lies in an azimuth range (deg, az1 >= az0). */
  lowerBoundInAzimuths(az0: number, az1: number): boolean
}

export type VisibilitySite = { lat: number; lon: number; horizon: HorizonData | null }

function profileOf(h: HorizonData): SkylineProfile | null {
  if (h.status !== 'available') return null
  return {
    elevationsDeg: h.samples.elevationsDeg, startAzimuthDeg: h.samples.startAzimuthDeg, stepDeg: h.samples.stepDeg,
    lowerBound: h.coverage?.sampleStatus.map((x) => x === 'lower-bound'),
  }
}

/** Cosine of the angle between two sky directions given as elevation/azimuth (deg). */
function dot3(a: { elevation: number; azimuth: number }, b: { elevation: number; azimuth: number }): number {
  const r = Math.PI / 180
  return Math.sin(a.elevation * r) * Math.sin(b.elevation * r) + Math.cos(a.elevation * r) * Math.cos(b.elevation * r) * Math.cos((a.azimuth - b.azimuth) * r)
}

const geometryOf = (b: { elevation: number; azimuth: number; angularRadius: number; distanceKm: number }): BodyGeometry =>
  ({ elevationDeg: b.elevation, azimuthDeg: b.azimuth, angularRadiusDeg: b.angularRadius, distanceKm: b.distanceKm })

export function visibilityModel(site: VisibilitySite, opts: { earthMinElevationDeg: number }): VisibilityModel {
  if (!Number.isFinite(site.lat) || Math.abs(site.lat) > 90 || !Number.isFinite(site.lon)) throw new RangeError('Invalid site coordinate')
  if (!Number.isFinite(opts.earthMinElevationDeg) || Math.abs(opts.earthMinElevationDeg) >= 90) throw new RangeError('Invalid minimum Earth elevation')
  const horizon = site.horizon
  const gate = horizon ? requireHorizon(horizon, { acceptLowerBounds: true }) : null
  const reasons: ConditionReason[] = !horizon
    ? [{ code: 'horizon-missing', message: 'No terrain horizon is attached to the site' }]
    : gate && !gate.ok ? gate.condition.reasons : []
  const ready = reasons.length === 0
  const profile = ready && horizon ? profileOf(horizon) : null
  const observer = horizon?.status === 'available' ? horizon.observer : undefined
  const radiusKm = observer?.radiusKm ?? MOON_R_KM
  const minEl = opts.earthMinElevationDeg
  const radiusNote: ConditionReason[] = observer ? [] : [{ code: 'observer-radius-default', message: 'Observer placed on the 1737.4 km reference sphere (no site elevation)' }]
  const notFormal = (extra: ConditionReason[] = []) => [...reasons, ...radiusNote, ...extra]

  const sunAt = (tMs: number): SunVisibility => {
    const sky = siteSky(site.lat, site.lon, new Date(tMs), radiusKm)
    const g = geometryOf(sky.sun)
    const off = tangentOffsetDeg(g, geometryOf(sky.earth))
    const occ = off ? { ...off, radiusDeg: sky.earth.angularRadius } : null
    const fullyOcculted = !!off && Math.hypot(off.dxDeg, off.dyDeg) + sky.sun.angularRadius <= sky.earth.angularRadius
    const disc = { azimuthDeg: g.azimuthDeg, elevationDeg: g.elevationDeg, radiusDeg: g.angularRadiusDeg }
    const sep = (Math.acos(Math.max(-1, Math.min(1, dot3(sky.sun, sky.earth)))) * 180) / Math.PI
    const noMargins = { terrainMarginDeg: null, terrainClearanceDeg: null, earthSeparationDeg: sep }
    const base = { tMs, geometry: g, formal: ready }
    if (!profile) {
      const occulted = discFraction(disc, null, occ).occulted
      if (fullyOcculted) {
        return { ...base, ...noMargins, terrainVisible: null, terrainVisibleFraction: null, earthOccultedFraction: 1, visibleFraction: 0, visibleFractionUpperBound: null, sunlit: false, blockedBy: ['earth'], reasons: notFormal([{ code: 'sun-total-earth-occultation', message: 'The Sun is entirely behind the Earth, whatever the terrain' }]) }
      }
      return { ...base, ...noMargins, terrainVisible: null, terrainVisibleFraction: null, earthOccultedFraction: occulted, visibleFraction: null, visibleFractionUpperBound: null, sunlit: null, blockedBy: occulted > 0 ? ['earth'] : [], reasons: notFormal() }
    }
    const f = discFraction(disc, profile, occ)
    const topMargin = discTopMarginDeg(disc, (az) => skylineAt(profile, az).valueDeg)
    const margins = { terrainMarginDeg: topMargin, terrainClearanceDeg: g.elevationDeg - g.angularRadiusDeg - f.skylineMaxInSpanDeg, earthSeparationDeg: sep }
    const blockedBy: Array<'terrain' | 'earth'> = []
    if (f.occulted > 0) blockedBy.push('earth')
    if (!f.usesLowerBound || topMargin <= 0) {
      // Complete skyline under the disc, or the disc lies wholly below a lower bound (hidden whatever the gap holds).
      const terrainVisible = topMargin > 0
      if (f.aboveSkyline < 1) blockedBy.unshift('terrain')
      const visibleFraction = terrainVisible ? f.visible : 0
      const sunlit = terrainVisible && !fullyOcculted && (f.occulted === 0 || f.visible > 0)
      return { ...base, ...margins, terrainVisible, terrainVisibleFraction: terrainVisible ? f.aboveSkyline : 0, earthOccultedFraction: f.occulted, visibleFraction, visibleFractionUpperBound: null, sunlit, blockedBy, reasons: f.usesLowerBound ? [{ code: 'sun-below-lower-bound', message: 'The disc is below a lower-bound skyline, so it is hidden whatever the data gap holds' }] : [] }
    }
    if (fullyOcculted) {
      return { ...base, ...margins, terrainVisible: null, terrainVisibleFraction: null, earthOccultedFraction: 1, visibleFraction: 0, visibleFractionUpperBound: null, sunlit: false, blockedBy: ['earth'], reasons: [{ code: 'sun-total-earth-occultation', message: 'The Sun is entirely behind the Earth, whatever the terrain' }] }
    }
    return {
      ...base, ...margins, terrainVisible: null, terrainVisibleFraction: null, earthOccultedFraction: f.occulted, visibleFraction: null, visibleFractionUpperBound: f.visible, sunlit: null, blockedBy,
      reasons: [{ code: 'sun-skyline-lower-bound', message: 'Part of the disc lies above a lower-bound skyline sample (data gap); its visibility is unknown' }],
    }
  }

  const earthAt = (tMs: number): EarthVisibility => {
    const sky = siteSky(site.lat, site.lon, new Date(tMs), radiusKm)
    const g = geometryOf(sky.earth)
    const base = { tMs, geometry: g, formal: ready, minElevationDeg: minEl }
    if (!profile) {
      // Below the minimum elevation the verdict does not depend on terrain.
      if (g.elevationDeg <= minEl) return { ...base, skylineDeg: null, skylineIsLowerBound: false, marginDeg: g.elevationDeg - minEl, visible: false, reasons: notFormal([{ code: 'earth-below-min-elevation', message: 'The Earth centre is not above the minimum elevation, whatever the terrain' }]) }
      return { ...base, skylineDeg: null, skylineIsLowerBound: false, marginDeg: null, visible: null, reasons: notFormal() }
    }
    const s = skylineAt(profile, g.azimuthDeg)
    const margin = g.elevationDeg - Math.max(s.valueDeg, minEl)
    if (margin <= 0) return { ...base, skylineDeg: s.valueDeg, skylineIsLowerBound: s.lowerBound, marginDeg: margin, visible: false, reasons: [] }
    if (s.lowerBound) return { ...base, skylineDeg: s.valueDeg, skylineIsLowerBound: true, marginDeg: margin, visible: null, reasons: [{ code: 'earth-skyline-lower-bound', message: 'The Earth centre is above a lower-bound skyline sample (data gap); its visibility is unknown' }] }
    return { ...base, skylineDeg: s.valueDeg, skylineIsLowerBound: false, marginDeg: margin, visible: true, reasons: [] }
  }

  return {
    status: ready ? 'ready' : 'unavailable', reasons, observerRadiusKm: radiusKm,
    observerRadiusSource: observer ? 'horizon-observer' : 'reference-sphere',
    policy: { sun: SUN_VISIBILITY_POLICY, earth: earthVisibilityPolicy(minEl) }, model: VISIBILITY_MODEL, sunAt, earthAt,
    skylineMaxSlope: profile ? skylineMaxSlope(profile) : null,
    lowerBoundInAzimuths: (az0, az1) => (profile ? lowerBoundInSpan(profile, az0, az1) : false),
  }
}
