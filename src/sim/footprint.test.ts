// SYNTHETIC FIXTURES: analytic surfaces and invented hazards with known answers. They test the algorithm only and are
// never candidate results (those are in footprintCandidates.test.ts).
import { vi, describe, expect, it } from 'vitest'
import { assessFootprint, footprintConfig, hazardOverlap, sensitivityBoundM, workingBoundM } from './footprint'
import type { FootprintDtm, FootprintInput, KnownHazard, ObstacleSurvey } from './footprint'
import { defaultAdvancedSettings } from './defaults'
// Real-ephemeris brute-force references in this file take 1-4 s alone and timed out at the 5 s default under
// parallel load; a run-time limit only, no numerical tolerance depends on it.
vi.setConfig({ testTimeout: 60_000 })


const R = 1_737_400, DEG = Math.PI / 180
const site = { lat: 10, lon: 20, frame: 'synthetic' }
const cfg = footprintConfig(defaultAdvancedSettings()) // 3 m, 5 deg, 0.3 m from the defaults file
const east = (_lat: number, lon: number) => (lon - site.lon) * DEG * R * Math.cos(site.lat * DEG)
const north = (lat: number) => (lat - site.lat) * DEG * R

/** A plane rising eastward at `deg`, optionally with a box obstacle and a hole. */
const surface = (deg: number, extra: (e: number, n: number) => number | null = () => 0) =>
  (lat: number, lon: number) => { const e = east(lat, lon), n = north(lat); const x = extra(e, n); return x === null ? null : Math.tan(deg * DEG) * e + x }

const fine = (heightAt: FootprintDtm['heightAt'], over: Partial<FootprintDtm> = {}): FootprintDtm => ({
  productId: 'synthetic-dtm', sourceIds: [], heightAt, confidenceLegend: 'none', postingM: 0.05,
  verticalError: { valueM: 0, statistic: 'bound' }, registration: { valueM: 0, statistic: 'bound' }, frame: 'same-as-site', ...over,
})
const clearSurvey: ObstacleSurvey = { id: 'synthetic-survey', sourceIds: [], method: 'in-situ', minDetectableHeightM: 0.1, coverage: 'full', detections: [] }
const input = (dtm: FootprintInput['dtm'], over: Partial<FootprintInput> = {}): FootprintInput => ({
  site, config: cfg, dtm, obstacleSurveys: [], hazards: [], hazardInventory: { complete: true, basis: 'synthetic' }, ...over,
})
const hardware = (over: Partial<KnownHazard> = {}): KnownHazard => ({
  id: 'hw', name: 'Synthetic lander', kind: 'hardware', lat: site.lat, lon: site.lon, relation: 'site-coordinate-marks-hazard', frameReconciled: true,
  position: [{ valueM: 0.3, statistic: 'bound' }], minHalfExtentM: 1.9, maxHalfExtentM: 4.7, minObstructionHeightM: 3.2, dimensionsVerified: true, sourceIds: [], ...over,
})
const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code)

describe('footprint configuration and uncertainty rules', () => {
  it('takes the footprint and thresholds from the settings, not from constants', () => {
    expect(cfg).toMatchObject({ diameterM: 3, slopeLimitDeg: 5, obstacleLimitM: 0.3 })
    expect(footprintConfig({ footprintDiameterM: 5, slopeLimitDeg: 8, obstacleLimitM: 0.5 }).diameterM).toBe(5)
  })
  it('never reads an uncertainty of unknown meaning as zero, a bound, 3 sigma or 1 sigma', () => {
    expect(workingBoundM({ valueM: 0, statistic: 'unknown' }, 2)).toBeNull()
    expect(workingBoundM({ valueM: null, statistic: 'bound' }, 2)).toBeNull()
    expect(workingBoundM({ valueM: 2, statistic: 'unknown' }, 2)).toBeNull() // no decision from an unknown statistic
    expect(sensitivityBoundM({ valueM: 2, statistic: 'unknown' }, 3)).toBe(6) // what-if value only
    expect(sensitivityBoundM({ valueM: 0, statistic: 'unknown' }, 3)).toBeNull()
    expect(workingBoundM({ valueM: 2, statistic: '1-sigma' }, 1)).toBeCloseTo(3.29, 9)
    expect(workingBoundM({ valueM: 2, statistic: '90-percent' }, 1)).toBe(2)
  })
})

describe('slope (synthetic planes)', () => {
  const slope = (deg: number, over: Partial<FootprintDtm> = {}) => assessFootprint(input(fine(surface(deg), over), { obstacleSurveys: [clearSurvey] }))
  it('passes below, fails at and above the limit', () => {
    expect(slope(4.9).slope.status).toBe('pass')
    expect(slope(5).slope.status).toBe('fail')
    expect(slope(5.1).slope.status).toBe('fail')
    expect(slope(4.9).terrain.status).toBe('pass') // all sub-conditions proven with adequate data
  })
  it('stays unknown when the vertical error spans the limit', () => {
    const r = slope(4.5, { verticalError: { valueM: 0.01, statistic: '90-percent' } }) // ~16 deg over a 0.05 m baseline
    expect(r.slope.status).toBe('unknown')
    expect(codes(r.slope)).toContain('slope-near-limit')
  })
  it('does not use coarse, upsampled or unregistered data', () => {
    expect(codes(slope(1, { postingM: 2 }).slope)).toContain('slope-dtm-too-coarse')
    expect(codes(slope(1, { postingM: 0.05, effectiveResolutionM: 6 }).slope)).toContain('slope-dtm-too-coarse')
    expect(codes(slope(1, { upsampled: true }).slope)).toContain('slope-upsampled-data')
    expect(codes(slope(1, { registration: null }).slope)).toContain('slope-registration-unknown')
    expect(codes(slope(1, { frame: 'unverified' }).slope)).toContain('slope-frame-unverified')
    expect(slope(1, { postingM: 2 }).slope.values?.indicativeSlopeErrorAtFootprintDeg.value).toBe(0) // exact synthetic data
    // A single-post error (like NAC RLE90) is not an error of height differences: no slope decision from it.
    expect(codes(slope(1, { verticalError: { valueM: 0.001, statistic: '90-percent', scope: 'single-post' } }).slope)).toContain('slope-vertical-error-scope')
  })
  it('a gap or a flagged confidence code inside the placement margin gives unknown, not a pass', () => {
    const hole = fine(surface(1, (e, n) => (Math.hypot(e - 1, n) < 0.2 ? null : 0)))
    expect(codes(assessFootprint(input(hole)).slope)).toContain('slope-data-gap')
    const flagged = fine(surface(1), { codeAt: (la, lo) => (east(la, lo) > 1.2 ? 3 : 12), acceptedCodes: [12], confidenceLegend: 'confirmed' })
    expect(codes(assessFootprint(input(flagged)).slope)).toContain('slope-confidence-flagged')
    const legend = fine(surface(1), { codeAt: () => 12, acceptedCodes: [12], confidenceLegend: 'unconfirmed' })
    expect(codes(assessFootprint(input(legend)).slope)).toContain('slope-confidence-legend-unconfirmed')
  })
  it('accounts for placement: a steep patch near the edge fails only if every placement contains it', () => {
    // 10 deg patch 1.2-1.6 m east of the site on a flat plain.
    const patch = (e: number) => (e > 1.2 && e < 1.6 ? Math.tan(10 * DEG) * (e - 1.2) : e >= 1.6 ? Math.tan(10 * DEG) * 0.4 : 0)
    const dtm = (placement: number) => fine((la, lo) => patch(east(la, lo)), { registration: { valueM: placement, statistic: 'bound' } })
    expect(assessFootprint(input(dtm(0))).slope.status).toBe('fail') // inside the exact footprint
    expect(assessFootprint(input(dtm(0.5))).slope.status).toBe('unknown') // some placements avoid it, some do not
  })
})

describe('obstacles (synthetic boxes and surveys)', () => {
  const box = (h: number) => fine(surface(0, (e, n) => (Math.abs(e) < 0.3 && Math.abs(n) < 0.3 ? h : 0)))
  it('fails for a 0.5 m box, passes for a 0.1 m box with fine, accurate data', () => {
    expect(assessFootprint(input(box(0.5))).obstacles.status).toBe('fail')
    expect(assessFootprint(input(box(0.1))).obstacles.status).toBe('pass')
  })
  it('a survey detection exactly at the limit fails; not finding obstacles with a 1 m survey proves nothing', () => {
    const at = (heightM: number): ObstacleSurvey => ({ ...clearSurvey, detections: [{ id: 'rock', lat: site.lat, lon: site.lon, heightM, heightUncertainty: { valueM: 0, statistic: 'bound' }, halfExtentM: 0.2, position: [{ valueM: 0.1, statistic: 'bound' }] }] })
    expect(assessFootprint(input(null, { obstacleSurveys: [at(0.3)] })).obstacles.status).toBe('fail')
    expect(assessFootprint(input(null, { obstacleSurveys: [at(0.29)] })).obstacles.status).toBe('pass')
    const coarse: ObstacleSurvey = { ...clearSurvey, minDetectableHeightM: 1 }
    const r = assessFootprint(input(null, { obstacleSurveys: [coarse] })).obstacles
    expect(r.status).toBe('unknown')
    expect(codes(r)).toContain('obstacle-survey-insufficient')
  })
  it('a 2 m DTM cannot resolve 0.3 m obstacles', () => {
    expect(codes(assessFootprint(input(fine(surface(0), { postingM: 2 }))).obstacles)).toContain('obstacle-dtm-too-coarse')
  })
})

describe('known hazards', () => {
  const at = (eastM: number) => ({ lat: site.lat, lon: site.lon + eastM / (R * Math.cos(site.lat * DEG)) / DEG })
  it('classifies confirmed overlap, possible overlap and confirmed clearance from verified geometry', () => {
    expect(hazardOverlap(hardware(), site, cfg).status).toBe('confirmed-overlap') // bound 0.3 m < 1.5 + 1.9 m
    expect(hazardOverlap(hardware({ position: [{ valueM: 3.5, statistic: 'bound' }] }), site, cfg).status).toBe('possible-overlap') // 3.5 > 3.4 m
    expect(hazardOverlap(hardware({ ...at(30), relation: 'separate-coordinate', frameReconciled: true, position: [{ valueM: 1, statistic: 'bound' }] }), site, cfg).status).toBe('confirmed-clear')
    expect(hazardOverlap(hardware({ dimensionsVerified: false }), site, cfg).status).toBe('possible-overlap') // nearby is not overlap
  })
  it('does not decide with an unreconciled frame or an unknown uncertainty', () => {
    expect(hazardOverlap(hardware({ ...at(30), relation: 'separate-coordinate', frameReconciled: false }), site, cfg).status).toBe('undetermined')
    expect(hazardOverlap(hardware({ ...at(30), relation: 'separate-coordinate', frameReconciled: true, position: [{ valueM: 1, statistic: 'unknown' }] }), site, cfg).status).toBe('undetermined')
  })
  it('an object at the site coordinate with an unbounded position error stays a possible overlap, with what-if values', () => {
    // As for Apollo 11: 0.3 m stated with unknown statistic. Never confirmed, never cleared; the risk is kept.
    const h = hazardOverlap(hardware({ position: [{ valueM: 0.3, statistic: 'unknown' }] }), site, cfg)
    expect(h.status).toBe('possible-overlap')
    expect(h.reason.code).toBe('hazard-position-bound-unproven')
    expect(h.values.sensitivityPositionM.value).toBeCloseTo(0.9, 9)
    expect(h.values.sensitivityOverlapMarginM.value).toBeCloseTo(1.5 + 1.9 - 0.9, 9)
    expect(hazardOverlap(hardware({ position: [{ valueM: 0, statistic: 'unknown' }] }), site, cfg).status).toBe('possible-overlap')
  })
  it('keeps a confirmed hazard together with the other unknown reasons', () => {
    const r = assessFootprint(input(fine(surface(1), { postingM: 2 }), { hazards: [hardware()], hazardInventory: { complete: false, basis: 'synthetic' } }))
    expect(r.terrain.status).toBe('fail')
    expect(codes(r.terrain)).toEqual(expect.arrayContaining(['hazard-overlap-confirmed', 'slope-dtm-too-coarse', 'obstacle-no-survey', 'hazard-inventory-incomplete']))
    expect(codes(r.terrain)[0]).toBe('hazard-overlap-confirmed') // failures first
  })
  it('passes the hazard part only with an exhaustive inventory and every hazard clear', () => {
    const clear = hardware({ ...at(30), relation: 'separate-coordinate', frameReconciled: true, position: [{ valueM: 1, statistic: 'bound' }] })
    expect(assessFootprint(input(null, { hazards: [clear] })).hazards.status).toBe('pass')
    expect(assessFootprint(input(null, { hazards: [clear], hazardInventory: { complete: false, basis: 'x' } })).hazards.status).toBe('unknown')
  })
})

describe('failures of data or computation are errors, never physical failures', () => {
  it('maps a load error to error and a missing load to unknown', () => {
    const e = assessFootprint(input({ error: { code: 'terrain-network', message: 'connection reset' } }))
    expect(e.terrain.status).toBe('error')
    expect(e.data.status).toBe('error')
    const u = assessFootprint(input({ unavailable: { code: 'terrain-not-loaded', message: 'not loaded' } }))
    expect(u.terrain.status).toBe('unknown')
  })
  it('a load error does not hide a confirmed hazard failure', () => {
    expect(assessFootprint(input({ error: { code: 'terrain-corrupt', message: 'checksum' } }, { hazards: [hardware()] })).terrain.status).toBe('fail')
  })
  it('a throwing sampler or invalid configuration becomes error', () => {
    const boom = fine(() => { throw new Error('decoder failed') })
    expect(assessFootprint(input(boom)).terrain.status).toBe('error')
    expect(assessFootprint(input(null, { config: { ...cfg, diameterM: 0 } })).terrain.reasons[0].code).toBe('footprint-computation-error')
  })
})
