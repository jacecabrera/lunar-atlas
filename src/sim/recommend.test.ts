// Step 13. SYNTHETIC candidate inputs (hand-built condition results and intervals) test the rules; the last block runs
// the formal entry on the 12 real catalogue candidates and records what the current data support.
import { vi, describe, expect, it } from 'vitest'
import { communicationCondition, recommend, rankCandidates, evaluateCandidate } from './recommend'
import type { CandidateInputs } from './recommend'
import type { ConditionResult } from './assessment'
import type { Interval } from '../physics/siteTimeline'
import { defaultAdvancedSettings } from './defaults'
import { CURRENT_MODEL_VERSIONS, taskFingerprint } from './task'
import { loadCandidateCatalog } from './catalog'
import { catalogCandidateInputs } from './candidateEvaluation'
import { diskTerrainStore } from './testing/publishedTerrain'
// Real-ephemeris brute-force references in this file take 1-4 s alone and timed out at the 5 s default under
// parallel load; a run-time limit only, no numerical tolerance depends on it.
vi.setConfig({ testTimeout: 60_000 })


const DAY = 86_400_000
const W = { startMs: 0, endMs: 10 * DAY }
// These are the STRICT (Evidence-based assessment) rules; the relaxed (Regional estimate) rules are tested in regionalEvaluation.test.ts.
const settings = { ...defaultAdvancedSettings(), assessmentMode: 'strict' as const }
const pass: ConditionResult = { status: 'pass', reasons: [] }
const unknown = (code: string): ConditionResult => ({ status: 'unknown', reasons: [{ code, message: code }] })
const fail = (code: string): ConditionResult => ({ status: 'fail', reasons: [{ code, message: code }] })
const error = (code: string): ConditionResult => ({ status: 'error', reasons: [{ code, message: code }] })

type Opt = {
  origin?: 'historical' | 'custom'; lat?: number; lon?: number
  terrain?: ConditionResult; slopeDeg?: number | null; footprintData?: ConditionResult
  energy?: ConditionResult; energyStatus?: 'determined' | 'bounded' | 'error'
  earthVisible?: Interval[]; earthPossible?: Interval[]; supplyProven?: Interval[]; supplyPossible?: Interval[]
  sunMs?: number | null; earthMs?: number | null; sunStatus?: 'complete' | 'bounded' | 'incomplete'
}
function cand(id: string, o: Opt = {}): CandidateInputs {
  const whole = [{ start: W.startMs, end: W.endMs }]
  const slope = o.slopeDeg === undefined ? 2 : o.slopeDeg
  return {
    candidate: { id, name: id, origin: o.origin ?? 'historical', lat: o.lat ?? 0, lon: o.lon ?? 0, frame: 'synthetic' },
    footprint: {
      terrain: o.terrain ?? pass,
      slope: o.terrain && o.terrain.status !== 'pass' ? { status: 'unknown', reasons: [] } : { status: 'pass', reasons: [], values: { maxSlopeDeg: slope === null ? { value: null, unit: 'deg', reason: 'x' } : { value: slope, unit: 'deg' } } },
      data: o.footprintData ?? pass,
    },
    energy: {
      window: W, condition: o.energy ?? pass, status: o.energyStatus ?? 'determined',
      supply: { proven: o.supplyProven ?? whole, possible: o.supplyPossible ?? o.supplyProven ?? whole },
      earth: { visible: o.earthVisible ?? whole, possible: o.earthPossible ?? o.earthVisible ?? whole, search: {} as never },
    },
    statistics: {
      window: W, sunStatus: o.sunStatus ?? 'complete', earthStatus: 'complete', reasons: [],
      sunlitDuration: o.sunMs === null ? { value: null, unit: 'ms', reason: 'x' } : { value: o.sunMs ?? 5 * DAY, unit: 'ms' },
      earthVisibleDuration: o.earthMs === null ? { value: null, unit: 'ms', reason: 'x' } : { value: o.earthMs ?? 10 * DAY, unit: 'ms' },
    },
  }
}

describe('necessary conditions and the summary rule', () => {
  it('four passes make a candidate eligible, with S = 100 (0.5 L + 0.3 C + 0.2 T)', () => {
    const e = evaluateCandidate(cand('a'), settings)
    expect(e.assessment.summary.landingAllowed).toBe(true)
    expect(e.score!.value).toBeCloseTo(100 * (0.5 * 0.5 + 0.3 * 1 + 0.2 * (1 - 2 / 5)), 9) // 67
  })
  it('a proven failure gives false and keeps every other reason; unknown and error give null', () => {
    const f = evaluateCandidate(cand('a', { terrain: fail('slope-at-or-above-limit'), energy: unknown('energy-pv-unknown'), energyStatus: 'bounded' }), settings)
    expect(f.assessment.summary.landingAllowed).toBe(false)
    expect(f.assessment.summary.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['slope-at-or-above-limit', 'energy-pv-unknown']))
    expect(evaluateCandidate(cand('a', { terrain: unknown('slope-dtm-too-coarse') }), settings).assessment.summary.landingAllowed).toBeNull()
    const err = evaluateCandidate(cand('a', { energy: error('visibility-computation-error'), energyStatus: 'error' }), settings)
    expect(err.assessment.summary.landingAllowed).toBeNull() // an error is not a physical failure
    expect(err.assessment.summary.errored).toContain('power')
  })
  it('insufficient data makes dataCompleteness unknown (not fail), which never counts as a physical failure', () => {
    const e = evaluateCandidate(cand('a', { footprintData: unknown('slope-dtm-too-coarse') }), settings)
    expect(e.assessment.conditions.dataCompleteness.status).toBe('unknown')
    expect(evaluateCandidate(cand('a', { footprintData: error('terrain-corrupt') }), settings).assessment.conditions.dataCompleteness.status).toBe('error')
    expect(e.assessment.summary.landingAllowed).toBeNull()
    expect(e.assessment.summary.failed).toEqual([])
  })
})

describe('powered direct-to-Earth opportunity', () => {
  const comm = (o: Opt) => communicationCondition(cand('a', o).energy)
  it('in darkness on battery power counts (sunlight is not required)', () => {
    expect(comm({ earthVisible: [{ start: 6 * DAY, end: 8 * DAY }], supplyProven: [{ start: 0, end: W.endMs }] }).status).toBe('pass')
  })
  it('fails when the Earth is never visible, even if the energy is unknown', () => {
    expect(comm({ earthVisible: [], earthPossible: [], energy: unknown('x'), energyStatus: 'bounded' }).status).toBe('fail')
  })
  it('a zero-length touch is not an opportunity', () => {
    const c = comm({ earthVisible: [{ start: 5 * DAY, end: 6 * DAY }], supplyProven: [{ start: 0, end: 5 * DAY }], supplyPossible: [{ start: 0, end: 5 * DAY }] })
    expect(c.status).toBe('fail')
    expect(c.reasons[0].code).toBe('no-powered-earth-window')
  })
  it('an earlier supply failure does not remove a later powered window', () => {
    const e = evaluateCandidate(cand('a', { energy: fail('energy-reserve-reached'), earthVisible: [{ start: 7 * DAY, end: 8 * DAY }], supplyProven: [{ start: 0, end: 2 * DAY }, { start: 6 * DAY, end: W.endMs }] }), settings)
    expect(e.assessment.conditions.communication.status).toBe('pass')
    expect(e.assessment.summary.landingAllowed).toBe(false) // the power condition still fails
  })
  it('uses a conservative overlap: interior boundaries move in by their resolution, window edges do not', () => {
    const M = 60_000
    const comm = (earth: Interval[], supply: Interval[]) => communicationCondition({ ...cand('a', { earthVisible: earth, supplyProven: supply }).energy, stepMs: 5 * M })
    // A 2 min Earth window with supply all mission long: only the Earth edges are uncertain (10 s): proven, no minimum length.
    expect(comm([{ start: 5 * DAY, end: 5 * DAY + 2 * M }], [{ start: 0, end: W.endMs }]).status).toBe('pass')
    // Supply ends 3 min after the Earth window starts: within one 5 min step of the boundary -> unknown, not fail.
    const nearEnd = comm([{ start: DAY, end: 3 * DAY }], [{ start: 0, end: DAY + 3 * M }])
    expect(nearEnd.status).toBe('unknown')
    expect(nearEnd.reasons[0].code).toBe('powered-earth-window-boundary-uncertain')
    // Both ends uncertain: supply starts at +2 min, Earth window 12 min: conservative overlap [+7 min, +11 min 50 s].
    const both = comm([{ start: DAY, end: DAY + 12 * M }], [{ start: DAY + 2 * M, end: 2 * DAY }])
    expect(both.status).toBe('pass')
    expect(both.values!.poweredEarthWindowMs.value).toBe(4 * M + 50_000)
    // Supply starting at +8 min: shrinks past the Earth window end -> unknown.
    expect(comm([{ start: DAY, end: DAY + 12 * M }], [{ start: DAY + 8 * M, end: 2 * DAY }]).status).toBe('unknown')
  })
  it('possible but unproven windows stay unknown', () => {
    expect(comm({ earthVisible: [], earthPossible: [{ start: 0, end: DAY }], supplyProven: [], supplyPossible: [{ start: 0, end: DAY }] }).status).toBe('unknown')
  })
})

describe('scoring and recommendations', () => {
  it('a high score never makes an ineligible candidate a recommendation; a low eligible score is not cut', () => {
    const r = recommend([cand('high', { sunMs: 10 * DAY, terrain: unknown('slope-dtm-too-coarse') }), cand('low', { sunMs: 0, earthMs: DAY, slopeDeg: 4.9 })], settings)
    expect(r.recommendations.map((x) => x.siteId)).toEqual(['low'])
    expect(r.recommendations[0].score).toBeLessThan(15)
    expect(r.excluded.insufficientData.map((x) => x.siteId)).toEqual(['high'])
  })
  it('returns 0, 1, 2 or 3 recommendations, never padded', () => {
    expect(recommend([cand('a', { terrain: unknown('x') })], settings).recommendations).toHaveLength(0)
    expect(recommend([cand('a')], settings).recommendations).toHaveLength(1)
    expect(recommend([cand('a'), cand('b', { lon: 10 })], settings).recommendations).toHaveLength(2)
    const four = recommend(['a', 'b', 'c', 'd'].map((id, i) => cand(id, { lon: i * 10, sunMs: (5 + i) * DAY / 2 })), settings)
    expect(four.recommendations).toHaveLength(3)
    expect(four.excluded.beyondLimit).toHaveLength(1)
  })
  it('rejects invalid weights, normalises valid ones, and a zero weight does not bypass a condition', () => {
    expect(recommend([cand('a')], { ...settings, weights: { sunlight: 0, earth: 0, terrain: 0 } }).status).toBe('invalid-settings')
    expect(recommend([cand('a')], { ...settings, weights: { sunlight: -1, earth: 1, terrain: 1 } }).status).toBe('invalid-settings')
    expect(recommend([cand('a')], { ...settings, weights: { sunlight: Number.NaN, earth: 1, terrain: 1 } }).status).toBe('invalid-settings')
    const s1 = recommend([cand('a')], { ...settings, weights: { sunlight: 1, earth: 1, terrain: 1 } }).ranked[0].score
    const s2 = recommend([cand('a')], { ...settings, weights: { sunlight: 2, earth: 2, terrain: 2 } }).ranked[0].score
    expect(s1).toBeCloseTo(s2, 12)
    const noT = recommend([cand('a', { terrain: unknown('x') })], { ...settings, weights: { sunlight: 1, earth: 1, terrain: 0 } })
    expect(noT.recommendations).toHaveLength(0)
  })
  it('uses only a passed footprint slope for T, never 0 for a missing value', () => {
    expect(evaluateCandidate(cand('a', { slopeDeg: null }), settings).score).toBeNull()
    expect(evaluateCandidate(cand('a', { sunMs: null, sunStatus: 'bounded' }), settings).score).toBeNull()
  })
  it('ties at 0.01: historical first, then spread, then stable ID; independent of input order', () => {
    // Scores 67.004 and 66.996 both round to 6700 (same group); 66.94 is lower.
    const sunFor = (s: number) => ((s / 100 - 0.3 - 0.2 * 0.6) / 0.5) * W.endMs
    const list = [
      cand('h-near', { lat: 0, lon: 1, sunMs: sunFor(67.004) }),
      cand('h-far', { lat: 0, lon: 60, sunMs: sunFor(66.996) }),
      cand('h-first', { lat: 0, lon: 0, sunMs: sunFor(67.5) }),
      cand('c-tie', { origin: 'custom', lat: 0, lon: 90, sunMs: sunFor(67.0) }),
      cand('h-lower', { lat: 0, lon: 120, sunMs: sunFor(66.94) }),
    ]
    const r = recommend(list, settings)
    expect(r.ranked.map((x) => x.siteId)).toEqual(['h-first', 'h-far', 'h-near', 'c-tie', 'h-lower'])
    expect(r.recommendations.map((x) => x.siteId)).toEqual(['h-first', 'h-far', 'h-near'])
    // Same distances: stable ID decides.
    const sym = rankCandidates([cand('x', { lon: 0 }), cand('b', { lon: 10 }), cand('a', { lon: -10 })].map((c) => evaluateCandidate(c, settings)))
    expect(sym.map((x) => x.siteId)).toEqual(['a', 'b', 'x'])
    // Any input order gives the same result.
    const rev = recommend([...list].reverse(), settings)
    expect(JSON.stringify(rev.ranked)).toBe(JSON.stringify(r.ranked))
    expect(JSON.stringify(rev.recommendations)).toBe(JSON.stringify(r.recommendations))
  })
  it('custom sites are ranked but never fill recommendation slots', () => {
    const r = recommend([cand('h1'), cand('custom', { origin: 'custom', sunMs: 10 * DAY, lon: 30 })], settings)
    expect(r.ranked[0].siteId).toBe('custom')
    expect(r.recommendations.map((x) => x.siteId)).toEqual(['h1'])
    expect(r.excluded.customNotRecommended).toEqual(['custom'])
  })
  it('result identity changes with the model or data version', () => {
    const f = (v: typeof CURRENT_MODEL_VERSIONS) => taskFingerprint({ input: { landingTimeMs: 0, durationMs: DAY, launchSite: { lat: 0, lon: 0 } } as never, settings, siteIds: ['a'], versions: v })
    expect(CURRENT_MODEL_VERSIONS.models.scoring).toMatch(/^score-v1\.4/)
    expect(f(CURRENT_MODEL_VERSIONS)).not.toBe(f({ ...CURRENT_MODEL_VERSIONS, models: { ...CURRENT_MODEL_VERSIONS.models, scoring: 'score-v2' } }))
    expect(f(CURRENT_MODEL_VERSIONS)).not.toBe(f({ ...CURRENT_MODEL_VERSIONS, data: { ...CURRENT_MODEL_VERSIONS.data, terrain: 'terrain-v1.2' } }))
  })
})

describe('12 catalogue candidates through the formal entry (published terrain)', async () => {
  const catalog = loadCandidateCatalog()
  const store = diskTerrainStore()
  const runFor = async (days: number) => {
    const window = { startMs: Date.UTC(2027, 0, 10), endMs: Date.UTC(2027, 0, 10) + days * DAY }
    const inputs = await Promise.all(catalog.candidates.map(async (c) => catalogCandidateInputs({ candidate: c, terrain: await store.load(c.id) }, catalog, settings, window)))
    return recommend(inputs, settings)
  }
  const runs = { 3: await runFor(3), 14: await runFor(14) }
  for (const days of [3, 14] as const) {
    it(`${days}-day mission: Chang'e 4 false (communication), the other 11 null, nobody eligible, all reasons kept`, () => {
      const r = runs[days]
      expect(r.status).toBe('ok')
      expect(r.recommendations).toEqual([])
      expect(r.excluded.serviceError).toEqual([])
      expect(r.excluded.physicalFail.map((x) => x.siteId)).toEqual(['change-4'])
      expect(r.excluded.insufficientData).toHaveLength(11)
      for (const e of r.evaluations) {
        const s = e.assessment.summary
        expect(s.eligibleForRecommendation, e.assessment.siteId).toBe(false)
        expect(e.assessment.conditions.terrain.status, e.assessment.siteId).toBe('unknown')
        expect(e.assessment.conditions.dataCompleteness.status, e.assessment.siteId).toBe('unknown')
        if (e.assessment.siteId === 'change-4') {
          expect(s.landingAllowed).toBe(false)
          expect(s.failed).toEqual(['communication'])
          // The failure does not hide the other reasons.
          expect(s.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['no-direct-earth-visibility', 'hazard-inventory-incomplete', 'slope-dtm-too-coarse']))
          expect(s.undetermined).toEqual(expect.arrayContaining(['terrain', 'dataCompleteness']))
        } else {
          expect(s.landingAllowed, e.assessment.siteId).toBeNull()
          expect(s.failed, e.assessment.siteId).toEqual([])
        }
        if (days === 3) expect(e.assessment.conditions.power.status, e.assessment.siteId).toBe('pass') // battery alone
      }
    })
  }
})
