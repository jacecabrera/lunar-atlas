// Details page (step 22): metrics from the saved statistics, unknown handling, next-event queries, explanations, source index and
// rendering. Task and snapshot wrappers are SYNTHETIC (see fixture.testhelper.ts); the statistics and horizons inside are REAL
// (Apollo 11 from the published terrain), and the unknown-time cases are produced by the real code with a missing horizon.
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadCandidateCatalog } from '../sim/catalog'
import { missionStatistics } from '../sim/events'
import type { MissionStatistics, NextSet } from '../sim/events'
import { visibilityModel } from '../sim/visibility'
import { CURRENT_MODEL_VERSIONS } from '../sim/task'
import type { PointData } from '../sim/task'
import type { DetailSnapshot } from '../sim/snapshot'
import { validateSnapshot, serializeSnapshot, parseSnapshot } from '../sim/snapshot'
import { duration, show } from './format'
import { metricRows, timelineSegments, completenessNote, unknownDurationMs, curvePoints } from './metrics'
import { computeNext } from './nextCompute'
import { reproducible, requestFor, describeNext, NEXT_SEARCH_MS } from './nextEventModel'
import { failRunning, issue, needsQuery, receive } from './nextState'
import { explain } from './explain'
import type { ExplainKey } from './explain'
import registerSource from '../../sources.md?raw'
import { lookup, parseRegister, safeHref, isUnverified } from './sources'
import { settingRows } from './settingsSummary'
import PointCard from './PointCard'
import { Loaded } from './DetailsApp'
import { realPointData, formalPointData, syntheticSnapshot, input, settings } from './fixture.testhelper'

let real: PointData // REAL Apollo 11 data: its statistics are incomplete (the published horizon has lower-bound azimuths)
let formal: PointData // (5N 130W, flat 0.2 deg skyline: sunlit, one sunset in the window, no Earth)
let formalEarth: PointData // (5N 84E: an Earthset in the window)
// fully determined statistics over a SYNTHETIC skyline (isolated fixture)
let snap: DetailSnapshot // formal data in a synthetic task
let realSnap: DetailSnapshot
beforeAll(async () => { real = await realPointData(); formal = formalPointData(); formalEarth = formalPointData('e', 5, 84); snap = syntheticSnapshot(['apollo-11'], formal); realSnap = syntheticSnapshot(['apollo-11'], real)
  void realSnap }, 60_000)

const win = () => ({ startMs: input.landingTimeMs, endMs: input.landingTimeMs + input.durationMs })
/** Statistics with unknown time, from the real code: no horizon attached, so terrain-dependent states are unknown. */
const unknownStats = (): MissionStatistics => missionStatistics(visibilityModel({ lat: 0.67416, lon: 23.47314, horizon: null }, { earthMinElevationDeg: 0 }), win())

describe('formatting', () => {
  it('formats durations and keeps a real zero as zero', () => {
    expect(duration(0)).toBe('0 s'); expect(duration(90_000)).toBe('1 min 30 s'); expect(duration(3 * 3_600_000 + 20 * 60_000)).toBe('3 h 20 min'); expect(duration(2 * 86_400_000 + 3_600_000)).toBe('2 d 1 h')
    expect(show({ value: 0, unit: 'ms' })).toMatchObject({ ok: true, text: '0 s' })
    expect(show({ value: -1.5, unit: 'deg' })).toMatchObject({ ok: true, text: '-1.50°' }) // negative elevations are kept
    expect(show({ value: null, unit: 'ms', reason: 'why' })).toEqual({ ok: false, text: 'N/A', reason: 'why' })
  })
})

describe('metrics from the saved statistics', () => {
  it('shows exactly the saved quantities and agrees with the timelines', () => {
    const s = formal.statistics
    const rows = Object.fromEntries(metricRows(s).map((r) => [r.key, r.value]))
    expect(rows.sunlitDuration).toMatchObject({ ok: true, raw: s.sunlitDuration.value })
    expect(rows.earthVisibleFraction).toMatchObject({ ok: true, raw: s.earthVisibleFraction.value })
    expect(rows.sunElevationMean).toMatchObject({ raw: s.sunElevationMean.value })
    const span = s.window.endMs - s.window.startMs
    const sum = (b: 'sun' | 'earth', st: string) => timelineSegments(s, b).filter((x) => x.state === st).reduce((a, x) => a + x.end - x.start, 0)
    expect(sum('sun', 'visible')).toBeCloseTo(s.sunlitDuration.value!, 3)
    expect(sum('earth', 'visible')).toBeCloseTo(s.earthVisibleDuration.value!, 3)
    expect((rows.sunlitFraction as { raw: number }).raw).toBeCloseTo((rows.sunlitDuration as { raw: number }).raw / span, 12)
    expect(rows.earthWindows).toMatchObject({ ok: true, raw: s.earthIntervals.length })
    for (const b of ['sun', 'earth'] as const) { // continuous, ordered, non-overlapping cover of the window
      const segs = timelineSegments(s, b)
      expect(segs[0].start).toBe(s.window.startMs); expect(segs[segs.length - 1].end).toBe(s.window.endMs)
      segs.slice(1).forEach((x, i) => expect(x.start).toBeCloseTo(segs[i].end, 6))
    }
    expect(s.status).not.toBe('incomplete')
  })
  it('shows the real Apollo 11 numbers as N/A with reasons (its horizon leaves time unknown), not as zeros', () => {
    expect(real.statistics.sunStatus).toBe('incomplete')
    const rows = metricRows(real.statistics)
    expect(rows.filter((r) => !r.value.ok).length).toBeGreaterThan(3)
    expect(rows.every((r) => r.value.ok || r.value.reason.length > 5)).toBe(true)
    expect(timelineSegments(real.statistics, 'sun').some((x) => x.state === 'unknown')).toBe(true)
  })
  it('never turns unknown time into dark, hidden or zero', () => {
    const s = unknownStats()
    expect(s.sunStatus).toBe('incomplete')
    const rows = metricRows(s)
    for (const k of ['sunlitDuration', 'sunlitFraction', 'longestDarkness', 'sunElevationMean', 'sunElevationPeak'] as const) {
      const v = rows.find((r) => r.key === k)!.value
      expect(v.ok).toBe(false); expect(v.ok === false && v.reason.length).toBeGreaterThan(5)
    }
    const sun = timelineSegments(s, 'sun')
    expect(sun.every((x) => x.state === 'unknown')).toBe(true) // the whole window is unknown, not "not visible"
    expect(unknownDurationMs(sun)).toBe(s.window.endMs - s.window.startMs)
    const note = completenessNote(s)
    expect(note.level).toBe('incomplete'); expect(note.text).toMatch(/Known parts only \(not totals\)/)
  })
  it('keeps negative Sun elevations and does not bridge unknown samples in the curve', () => {
    const pts = curvePoints({ ...snap.points[0], data: { ...formal, statistics: { ...formal.statistics, sunSeries: [
      { tMs: 0, elevationDeg: -3.2, visibleFraction: 0, sunlit: false }, { tMs: 1, elevationDeg: 2, visibleFraction: 1, sunlit: true }, { tMs: 2, elevationDeg: 4, visibleFraction: null, sunlit: null }] } } })
    expect(pts.map((p) => p.elevationDeg)).toEqual([-3.2, 2, 4]); expect(pts[2].sunlit).toBeNull()
    expect(curvePoints(snap.points[0]).length).toBe(formal.statistics.sunSeries.length)
  })
})

describe('next sunset and Earthset', () => {
  const at = (ms: number, target: 'sunset' | 'earthset', site = formal.site) => computeNext({ requestId: 'x', pointId: 'p', target, queryMs: ms, searchMs: NEXT_SEARCH_MS, site, earthMinElevationDeg: 0, estimated: false })
  it('agrees with the events saved in the statistics (same model, same horizon)', () => {
    const q = formal.statistics.window.startMs
    for (const [target, d, ev] of [['sunset', formal, formal.statistics.sunTerrain], ['earthset', formalEarth, formalEarth.statistics.earth]] as const) {
      const first = ev.events.find((e) => e.kind === 'set' && e.tMs > q)
      const r = at(q, target, d.site)
      expect(first, `${target}: the fixture must have a set in the window`).toBeDefined()
      expect(r.status).toBe('found'); expect(Math.abs(r.eventMs! - first!.tMs)).toBeLessThanOrEqual(2000)
    }
  }, 60_000)
  it('depends only on the selected time, and a later time never changes the fixed metrics', () => {
    const before = JSON.stringify(metricRows(formal.statistics))
    const a = at(input.landingTimeMs, 'sunset'), b = at(input.landingTimeMs + 86_400_000, 'sunset')
    expect(a.status).toBe('found'); expect(b.status).toBe('found'); expect(b.eventMs!).toBeGreaterThanOrEqual(a.eventMs!)
    expect(JSON.stringify(metricRows(formal.statistics))).toBe(before)
    expect(a.searchStartMs).toBe(input.landingTimeMs); expect(a.searchEndMs - a.searchStartMs).toBe(NEXT_SEARCH_MS)
  }, 60_000)
  it('reports unknown without a horizon, not-found when the Earth never rises, and never an event time of 0', () => {
    const noHorizon = { id: 'x', lat: 0.67, lon: 23.47, horizon: null }
    const u = at(input.landingTimeMs, 'sunset', noHorizon)
    expect(u.status).toBe('unknown'); expect(u.eventMs).toBeNull(); expect(u.msUntil).toBeNull()
    const far = at(input.landingTimeMs, 'earthset', { id: 'far', lat: 0, lon: 180, horizon: null })
    expect(far.status).toBe('not-found'); expect(far.eventMs).toBeNull(); expect(far.msUntil).toBeNull()
  }, 60_000)
  it('words every state, including incomplete, with the searched range and no zero', () => {
    const base: NextSet = { target: 'sun', channel: 'sun-terrain', queryMs: 0, searchStartMs: 0, searchEndMs: 86_400_000, searchedToMs: 43_200_000, status: 'incomplete', eventMs: null, msUntil: null, toleranceMs: null, cause: null, unresolvedMs: 0, reasons: [{ code: 'search-budget-exhausted', message: 'Searched only to 1970-01-01T12:00:00.000Z' }] }
    expect(describeNext(base, 'sunset')).toMatchObject({ state: 'incomplete' })
    expect(describeNext({ ...base, status: 'not-found', searchedToMs: 86_400_000, reasons: [] }, 'earthset')).toMatchObject({ state: 'not-found', headline: 'No Earthset in the searched range' })
    expect(describeNext({ ...base, status: 'unknown' }, 'sunset').headline).toMatch(/Unknown/)
    const found = describeNext({ ...base, status: 'found', eventMs: 3_600_000, msUntil: 3_600_000, toleranceMs: 500 }, 'sunset')
    expect(found.state).toBe('found'); expect(found.headline).toMatch(/1970-01-01 01:00:00 UTC/)
  })
  it('drops replies to outdated requests and never leaves a query running after a failure', () => {
    const r = (ms: number): NextSet => ({ target: 'sun', channel: 'sun-terrain', queryMs: ms, searchStartMs: ms, searchEndMs: ms + 1, searchedToMs: ms + 1, status: 'not-found', eventMs: null, msUntil: null, toleranceMs: null, cause: null, unresolvedMs: 0, reasons: [] })
    let s = issue({}, 'p|sunset', 'a', 1000)
    s = issue(s, 'p|sunset', 'b', 2000) // the selected time changed
    expect(receive(s, { requestId: 'a', result: r(1000) })).toBe(s) // stale reply: state unchanged
    const done = receive(s, { requestId: 'b', result: r(2000) })
    expect(done['p|sunset']).toMatchObject({ status: 'done', queryMs: 2000 })
    expect(receive(done, { requestId: 'b', result: r(9) })).toBe(done) // a finished request ignores a duplicate
    expect(needsQuery(done, 'p|sunset', 2000)).toBe(false); expect(needsQuery(done, 'p|sunset', 3000)).toBe(true); expect(needsQuery({}, 'k', 1)).toBe(true)
    expect(failRunning(s, 'boom')['p|sunset']).toMatchObject({ status: 'error', message: 'boom' })
    expect(needsQuery(failRunning(s, 'boom'), 'p|sunset', 2000)).toBe(true)
  })
  it('offers new queries only when the snapshot model can be reproduced, and says why not', () => {
    expect(reproducible(snap)).toEqual({ ok: true })
    const old = structuredClone(snap); old.versions.models.visibility = 'visibility-v1:old'
    const r = reproducible(old)
    expect(r.ok).toBe(false); expect(!r.ok && r.reason).toMatch(/visibility model/)
    const eph = structuredClone(snap); eph.versions.models.ephemeris = 'other'
    expect(!reproducible(eph).ok).toBe(true)
    const req = requestFor(snap, snap.points[0], 'sunset', 123, 'rid')
    expect(req).toMatchObject({ pointId: 'apollo-11', queryMs: 123, requestId: 'rid' }); expect(req.site).toEqual(snap.points[0].data.site)
  })
})

describe('explanations and the source index', () => {
  const keys: ExplainKey[] = ['sunlitDuration', 'sunlitFraction', 'longestDarkness', 'earthWindows', 'earthVisibleDuration', 'earthVisibleFraction', 'longestEarthVisible', 'longestEarthGap', 'sunAndEarthFraction', 'sunElevationMean', 'sunElevationPeak', 'timeline', 'curve', 'nextSunset', 'nextEarthset']
  it('every core number has a complete explanation filled with this snapshot, and every referenced ID is in the register', () => {
    for (const k of keys) {
      const e = explain(k, snap, snap.points[0])
      expect(e.title.length).toBeGreaterThan(3); expect(e.formula.length).toBeGreaterThan(5); expect(e.units.length).toBeGreaterThan(2)
      expect(e.variables.length).toBeGreaterThan(0); expect(e.rules.length).toBeGreaterThan(0); expect(e.resolution.length).toBeGreaterThan(0); expect(e.limits.length).toBeGreaterThan(0)
      expect(e.versions.join(' ')).toContain(CURRENT_MODEL_VERSIONS.models.visibility.slice(0, 20))
      expect(e.refs.length).toBeGreaterThan(0)
      for (const r of e.refs) expect(lookup(r.id), `${k}: ${r.id}`).not.toBeNull()
    }
    const e = explain('sunlitDuration', snap, snap.points[0])
    expect(e.variables.join(' ')).toContain('2027-01-10'); expect(e.resolution.join(' ')).toMatch(/10 s/)
    expect(explain('sunElevationMean', snap, snap.points[0]).units).toMatch(/negative/)
    expect(explain('nextSunset', snap, snap.points[0]).rules.join(' ')).toMatch(/eclipse.*not a sunset/i)
  })
  it('matches the register in sources.md (single maintenance) and keeps kinds apart', () => {
    const text = registerSource
    const reg = parseRegister(text)
    for (const id of ['SRC-ASTRONOMY-ENGINE', 'SRC-NASA-SVS-MOONKIT', 'ASM-UT1-EQUALS-UTC', 'ASM-EVENT-RESOLUTION']) expect(reg.has(id)).toBe(true)
    expect(reg.get('ASM-UT1-EQUALS-UTC')).toMatchObject({ type: 'assumption' }); expect(reg.get('ASM-UT1-EQUALS-UTC')!.title).toContain('|UT1 - UTC|')
    expect(reg.get('SRC-ASTRONOMY-ENGINE')).toMatchObject({ type: 'source', url: expect.stringMatching(/^https:/) })
    expect(isUnverified(reg.get('SRC-NASA-MOON-FACTSHEET')!)).toBe(true)
    expect(isUnverified(reg.get('SRC-NASA-SVS-MOONKIT')!)).toBe(false)
    expect(explain('sunlitDuration', snap, snap.points[0]).refs.map((r) => r.role)).toEqual(expect.arrayContaining(['assumption', 'model', 'source-value', 'dataset']))
  })
  it('only makes links from http(s) URLs', () => {
    expect(safeHref('https://example.org/a')).toBe('https://example.org/a')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'ftp://x', '', null, undefined, 'not a url']) expect(safeHref(bad as string | null)).toBeNull()
  })
})

describe('rendering', () => {
  const noNext = {}
  const card = (s: DetailSnapshot, p = s.points[0]) => renderToStaticMarkup(<PointCard p={p} snap={s} color="#fff" selectedMs={input.landingTimeMs} state={noNext} repro={{ ok: true }} onHide={() => undefined} onClose={() => undefined} />)
  it('renders values, an Explain button per core number, timelines and next-event rows', () => {
    const html = card(snap)
    for (const k of ['sunlitDuration', 'longestDarkness', 'earthWindows', 'longestEarthGap', 'sunAndEarthFraction', 'sunElevationMean', 'sunElevationPeak']) expect(html).toContain(`data-testid="value-${k}"`)
    expect((html.match(/>Explain</g) ?? []).length).toBeGreaterThanOrEqual(14)
    expect(html).toContain('data-next="sunset"'); expect(html).toContain('data-next="earthset"'); expect(html).toContain('Calculating…')
    expect(html).toContain('role="img"'); expect(html).toContain('UTC')
  })
  it('renders N/A with the reason for undetermined values, and the unknown state of the timelines', () => {
    const u = structuredClone(snap); u.points[0].data.statistics = unknownStats()
    const html = card(u)
    expect(html).toContain('N/A'); expect(html).toContain('Unknown or unsearched time in the mission window'); expect(html).toContain('data-level="incomplete"'); expect(html).toContain('data-state="unknown"')
    expect(html).not.toMatch(/value-sunlitDuration">0/)
  })
  it('shows the unavailable reason instead of next-event numbers when the model differs', () => {
    const html = renderToStaticMarkup(<PointCard p={snap.points[0]} snap={snap} color="#fff" selectedMs={0} state={noNext} repro={{ ok: false, reason: 'x' }} onHide={() => undefined} onClose={() => undefined} />)
    expect(html).toContain('Unavailable (model differs from this snapshot)'); expect(html).not.toContain('Calculating…')
  })
  it('renders the page: header, point list with show and close, grid; 1, several and 12 points; zero points with reasons', () => {
    const one = renderToStaticMarkup(<Loaded s={snap} />)
    expect(one).toContain('Mission details'); expect(one).toContain('Landing Time 2027-01-10 06:00:00 UTC'); expect(one).toContain('Show Apollo 11'); expect(one).toContain('Close Apollo 11')
    expect((one.match(/data-testid="point-card"/g) ?? []).length).toBe(1)
    const ids = loadCandidateCatalog().candidates.map((c) => c.id)
    const twelve = syntheticSnapshot(ids, formal)
    const html12 = renderToStaticMarkup(<Loaded s={twelve} />)
    expect((html12.match(/data-testid="point-card"/g) ?? []).length).toBe(12); expect(html12).toContain('minmax(340px, 1fr)')
    expect(html12).not.toMatch(/change from baseline/i)
    const three = renderToStaticMarkup(<Loaded s={syntheticSnapshot(ids.slice(0, 3), formal)} />)
    expect((three.match(/data-testid="point-card"/g) ?? []).length).toBe(3)
    const zero = renderToStaticMarkup(<Loaded s={syntheticSnapshot([], formal)} />)
    expect(zero).toContain('No comparable qualifying points'); expect(zero).toContain('slope too steep'); expect(zero).not.toContain('data-testid="point-card"'); expect(zero).toContain('Landing Time 2027-01-10')
  }, 60_000)
  it('does not modify the snapshot and keeps the settings readable', () => {
    const before = serializeSnapshot(snap)
    renderToStaticMarkup(<Loaded s={snap} />)
    expect(serializeSnapshot(snap)).toBe(before)
    const back = parseSnapshot(before)
    expect(back.ok && validateSnapshot(back.snapshot).ok).toBe(true)
    expect(settingRows(snap).find((r) => r.key === 'earthMinElevationDeg')).toMatchObject({ value: String(settings.earthMinElevationDeg) })
  })
})
