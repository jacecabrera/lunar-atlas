// Fixed-panel photovoltaic output (v0.7 section 5, step 11). Replaces "any sunlight = full power" for formal use.
//
//   S(t)     = S_1AU * (AU_KM / sunDistanceKm)^2                                    W/m2
//   P_raw(t) = S(t) * etaPV * sum_j [ A_j * f(t) * max(0, n_j . s(t)) ] * k_loss    W
//   P_PV(t)  = min(P_raw(t), pvOutputLimitW)                                        W (whole array)
//
// s(t): unit vector to the Sun centre in the local east-north-up frame of the site (azimuth clockwise from north,
// elevation up from the local horizontal plane), from the formal visibility model at the site's observer radius.
// n_j: panel normal; tilt is measured up from the horizontal plane (0 = facing the zenith, 90 = vertical), azimuth
// clockwise from north. Panels are fixed: they never track the Sun.
// f(t): visible fraction of the solar disc after terrain and the Earth (step 09). It is not a PV efficiency.
//
// Approximations (recorded, not hidden): both panels share one visible fraction (no self-shading data); the incidence
// cosine is taken at the disc centre and multiplied by the visible fraction; k_loss = 1 means dust, temperature and
// ageing are not modelled, not that they are zero. The controller limit applies to the whole array output.
import { AU_KM } from '../physics/coords'
import { enuFromAzEl } from '../physics/discVisibility'
import type { ConditionReason } from './assessment'
import type { DeviceConfig, SolarModelParams, PanelSpec } from './mission'
import type { SunVisibility, VisibilityModel } from './visibility'

export const PV_MODEL = 'pv-v1:fixed-panels;S=S1AU*(AU/d)^2;P=min(S*etaPV*sum(A*f*max(0,n.s))*kloss,limit);shared-f;centre-cosine'

export type PanelOutput = { panelId: string; incidenceCos: number; rawW: number | null; rawUpperW: number }

/**
 * PV output at one instant. `status`:
 *  - determined: powerW is the model value (lowerW = upperW = powerW)
 *  - bounded:    the visible fraction is unknown; the output lies in [lowerW, upperW]
 *  - error:      the geometry could not be computed; no bounds
 */
export type PvSample = {
  tMs: number
  status: 'determined' | 'bounded' | 'error'
  powerW: number | null
  lowerW: number | null
  upperW: number | null
  /** Before the controller limit; null unless determined. */
  rawW: number | null
  limited: boolean | null
  irradianceWm2: number | null
  sunDistanceKm: number | null
  sunElevationDeg: number | null
  sunAzimuthDeg: number | null
  visibleFraction: number | null
  panels: PanelOutput[]
  reasons: ConditionReason[]
}

export type PvSettings = { device: Pick<DeviceConfig, 'pvEfficiency' | 'panels' | 'pvOutputLimitW'>; model: SolarModelParams }

/** Panel normal in east-north-up. */
export function panelNormal(p: Pick<PanelSpec, 'azimuthDeg' | 'tiltDeg'>): [number, number, number] {
  const a = (p.azimuthDeg * Math.PI) / 180, t = (p.tiltDeg * Math.PI) / 180
  return [Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), Math.cos(t)]
}

/** Problems that make the PV settings unusable (subset of validateAdvancedSettings, for direct callers). */
export function validatePvSettings(s: PvSettings): string[] {
  const e: string[] = []
  const d = s.device
  if (!(d.pvEfficiency > 0 && d.pvEfficiency <= 1)) e.push('Solar efficiency must be greater than 0 and at most 1')
  if (!(d.pvOutputLimitW > 0) || !Number.isFinite(d.pvOutputLimitW)) e.push('Solar output limit must be a positive number')
  if (d.panels.length === 0) e.push('At least one panel is required')
  for (const p of d.panels) {
    if (!(p.areaM2 > 0) || !Number.isFinite(p.areaM2)) e.push(`Panel ${p.id} area must be a positive number`)
    if (!Number.isFinite(p.azimuthDeg)) e.push(`Panel ${p.id} azimuth must be finite`)
    if (!(p.tiltDeg >= 0 && p.tiltDeg <= 90)) e.push(`Panel ${p.id} tilt must be between 0 and 90 degrees`)
  }
  if (!(s.model.irradianceWm2 > 0) || !(s.model.referenceDistanceAu > 0)) e.push('Solar irradiance and reference distance must be positive')
  if (!(s.model.lossFactor > 0 && s.model.lossFactor <= 1)) e.push('Loss factor must be greater than 0 and at most 1')
  return e
}

/** PV output from a Sun state (pure; testable with synthetic states). */
export function pvFromSun(sun: SunVisibility, s: PvSettings): PvSample {
  const errors = validatePvSettings(s)
  if (errors.length) throw new RangeError(errors.join('; '))
  const g = sun.geometry
  const dir = enuFromAzEl(g.azimuthDeg, g.elevationDeg)
  const irradiance = s.model.irradianceWm2 * ((s.model.referenceDistanceAu * AU_KM) / g.distanceKm) ** 2
  const k = irradiance * s.device.pvEfficiency * s.model.lossFactor
  // Cosines below 1e-12 are floating-point residue (e.g. cos 90 deg = 6e-17), not light on the panel.
  const cos = s.device.panels.map((p) => { const n = panelNormal(p); const c = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]; return c > 1e-12 ? c : 0 })
  const clearSky = s.device.panels.reduce((sum, p, i) => sum + p.areaM2 * cos[i], 0) * k // f = 1
  const limit = s.device.pvOutputLimitW
  const base = { tMs: sun.tMs, irradianceWm2: irradiance, sunDistanceKm: g.distanceKm, sunElevationDeg: g.elevationDeg, sunAzimuthDeg: g.azimuthDeg, visibleFraction: sun.visibleFraction }
  const panels = (f: number | null): PanelOutput[] => s.device.panels.map((p, i) => ({ panelId: p.id, incidenceCos: cos[i], rawW: f === null ? null : p.areaM2 * cos[i] * k * f, rawUpperW: p.areaM2 * cos[i] * k }))
  if (sun.visibleFraction !== null || clearSky === 0) {
    // Known fraction, or the Sun is behind every panel (0 W whatever the fraction).
    const f = sun.visibleFraction ?? 0
    const raw = clearSky * f
    const p = Math.min(raw, limit)
    const reasons: ConditionReason[] = clearSky === 0 ? [{ code: 'pv-sun-behind-panels', message: 'The Sun is behind every panel' }] : []
    return { ...base, status: 'determined', powerW: p, lowerW: p, upperW: p, rawW: raw, limited: raw > limit, panels: panels(clearSky === 0 ? 0 : f), reasons }
  }
  // Unknown fraction: bound it. Upper: the stated upper bound, else 1 minus the known Earth cover.
  const fUpper = Math.min(sun.visibleFractionUpperBound ?? 1, 1 - sun.earthOccultedFraction)
  return {
    ...base, status: 'bounded', powerW: null, lowerW: 0, upperW: Math.min(clearSky * fUpper, limit), rawW: null, limited: null, panels: panels(null),
    reasons: [{ code: 'pv-visible-fraction-unknown', message: 'The visible part of the solar disc is unknown; the output is only bounded' }, ...sun.reasons],
  }
}

/** PV output at an instant through the formal visibility model. Computation failures give status 'error'. */
export function pvPowerAt(model: VisibilityModel, s: PvSettings, tMs: number): PvSample {
  try {
    return pvFromSun(model.sunAt(tMs), s)
  } catch (e) {
    if (e instanceof RangeError && /must|required/.test(e.message)) throw e // invalid settings are the caller's error
    return {
      tMs, status: 'error', powerW: null, lowerW: null, upperW: null, rawW: null, limited: null, irradianceWm2: null, sunDistanceKm: null,
      sunElevationDeg: null, sunAzimuthDeg: null, visibleFraction: null, panels: [],
      reasons: [{ code: 'pv-computation-error', message: e instanceof Error ? e.message : String(e) }],
    }
  }
}
