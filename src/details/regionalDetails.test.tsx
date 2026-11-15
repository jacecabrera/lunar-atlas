// The chain for estimated results, on real data: relaxed mission job (the catalogue is emptied by a tiny regional slope limit so the
// whole-Moon search runs) -> routes -> snapshot -> storage -> details page -> new next-event query. A version 2 (legacy) snapshot
// keeps reading as a strict one and nothing rewrites it.
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { runMissionJob, JOB_PROTOCOL_VERSION } from '../sim/job'
import { loadCandidateCatalog } from '../sim/catalog'
import { defaultAdvancedSettings } from '../sim/defaults'
import { CURRENT_MODEL_VERSIONS } from '../sim/task'
import type { TaskResult, TaskState } from '../sim/task'
import { diskTerrainStore, diskGlobalStore } from '../sim/testing/publishedTerrain'
import { buildSnapshot } from '../snapshots/build'
import { saveSnapshot, loadSnapshot, memoryBackend } from '../snapshots/storage'
import { validateSnapshot, newSnapshotId, serializeSnapshot, parseSnapshot } from '../sim/snapshot'
import type { DetailSnapshot } from '../sim/snapshot'
import { buildRouteModel, drawableRoutes } from '../scene/routeModel'
import { computeNext } from './nextCompute'
import { requestFor, reproducible, NEXT_SEARCH_MS } from './nextEventModel'
import { explain } from './explain'
import { lookup } from './sources'
import { metricRows, completenessNote } from './metrics'
import { Loaded } from './DetailsApp'
import { input } from './fixture.testhelper'

const catalog = loadCandidateCatalog()
const settings = { ...defaultAdvancedSettings(), assessmentMode: 'relaxed' as const, regionalSlopeLimitDeg: 0.12 } // isolated: empties the catalogue on real terrain
let result: TaskResult
let task: TaskState
let snap: DetailSnapshot

beforeAll(async () => {
  result = await runMissionJob({
    protocol: JOB_PROTOCOL_VERSION, requestId: 'r', fingerprint: 'FP', versions: CURRENT_MODEL_VERSIONS, input, settings, siteIds: catalog.candidates.map((c) => c.id), terrainBaseUrl: '', globalTerrainBaseUrl: '',
  }, { terrain: diskTerrainStore(), globalTerrain: diskGlobalStore(), isCancelled: () => false, progress: () => undefined, yieldNow: async () => undefined })
  task = { status: 'done', request: { requestId: 'r', fingerprint: 'FP', versions: CURRENT_MODEL_VERSIONS, startedAtMs: 0 }, result }
  const r = buildSnapshot({ task, input, settings, customs: [], maxCustom: 9, snapshotId: newSnapshotId(), nowMs: 1_700_000_000_000 })
  if (!r.ok) throw new Error(r.reason)
  snap = r.snapshot
}, 300_000)

describe('estimated results end to end (real data)', () => {
  it('the search found points, and they are valid points everywhere: routes, snapshot, details', () => {
    expect(result.recommendations).toHaveLength(0); expect(result.search!.results.length).toBeGreaterThanOrEqual(1)
    const model = buildRouteModel({ task, input, customs: [], maxCustom: 9 })
    expect(drawableRoutes(model).map((r) => r.kind)).toEqual(result.search!.results.map(() => 'search'))
    expect(model.markers.map((m) => m.id)).toEqual(result.search!.results.map((x) => x.siteId))
    expect(snap.points.map((p) => [p.id, p.kind])).toEqual(result.search!.results.map((x) => [x.siteId, 'search']))
    expect(snap.assessment).toMatchObject({ mode: 'relaxed', legacy: false }); expect(snap.assessment.search).toMatchObject({ status: 'complete' })
    for (const p of snap.points) { expect(p.assessment.decision).toMatchObject({ mode: 'relaxed', estimated: true, eligible: true, source: 'search' }); expect(p.data.statistics.estimated).toBe(true) }
    expect(snap.exclusions.length).toBeGreaterThan(0)
  })
  it('round-trips through storage unchanged, including the decision, scale and risks', async () => {
    const be = memoryBackend(); await saveSnapshot(be, snap)
    const r = await loadSnapshot(be, snap.snapshotId)
    expect(r.status === 'ok' && r.snapshot).toEqual(snap)
    expect(snap.points[0].assessment.decision!.risks.join(' ')).toMatch(/not evidence that there are none/)
  })
  it('the details page says "Regional estimate", names the search, lists risks, and never writes "recommended" for a search result', () => {
    const html = renderToStaticMarkup(<Loaded s={snap} />)
    expect(html).toContain('data-testid="mode-banner"'); expect(html).toContain('Regional estimate'); expect(html).toContain('data-testid="search-summary"')
    expect(html).toContain('Whole-Moon search result 1'); expect(html).toContain('data-testid="estimate-block"'); expect(html).toContain('Risks not evaluated')
    expect(html).not.toMatch(/Recommendation 1/)
    expect(completenessNote(snap.points[0].data.statistics).text).toMatch(/Estimated on a nominal skyline/)
    expect(metricRows(snap.points[0].data.statistics).every((r) => r.value.ok)).toBe(true) // determined on the nominal skyline (not N/A)
  })
  it('a new next-event query uses the estimated policy and agrees with the saved estimated events', () => {
    const p = snap.points[0], q = p.data.statistics.window.startMs
    expect(reproducible(snap)).toEqual({ ok: true })
    const req = requestFor(snap, p, 'earthset', q, 'x'); expect(req.estimated).toBe(true)
    const r = computeNext({ ...req, searchMs: NEXT_SEARCH_MS })
    const saved = p.data.statistics.earth.events.find((e) => e.kind === 'set' && e.tMs > q)
    if (saved) expect(Math.abs(r.eventMs! - saved.tMs)).toBeLessThanOrEqual(2000)
    else expect(['not-found', 'found', 'incomplete']).toContain(r.status) // no saved set in the window: nextSet looks further, or finds none
    // The strict policy on the same estimated horizon is unavailable (it would reject it): proof the flag matters.
    const strict = computeNext({ ...req, estimated: false, searchMs: NEXT_SEARCH_MS })
    expect(strict.status).toBe('unknown')
  })
  it('the explanations mention the estimate and every reference exists in the register', () => {
    const e = explain('sunlitDuration', snap, snap.points[0])
    expect(e.limits.join(' ')).toMatch(/Regional estimate/); expect(e.refs.map((r) => r.id)).toEqual(expect.arrayContaining(['ASM-ASSESSMENT-MODE', 'ASM-REGIONAL-SCREENING', 'ASM-SEARCH-POLICY', 'SRC-LOLA-GDR-CYL']))
    for (const r of e.refs) expect(lookup(r.id), r.id).not.toBeNull()
  })
  it('new queries are unavailable when the regional model of the snapshot differs', () => {
    const old = structuredClone(snap); old.versions.models.regional = 'regional-v0:old'
    const r = reproducible(old); expect(r.ok).toBe(false); expect(!r.ok && r.reason).toMatch(/regional/)
    const strictOld = structuredClone(snap); strictOld.assessment.mode = 'strict'; strictOld.versions.models.regional = 'x'
    expect(reproducible(strictOld)).toEqual({ ok: true }) // an evidence snapshot does not depend on the regional model
  })
})

describe('snapshot versions', () => {
  it('reads a version 2 snapshot as a legacy strict snapshot, leaves the stored text alone, and says so on the page', () => {
    const v2 = JSON.parse(serializeSnapshot(snap)) as Record<string, unknown>
    v2.schemaVersion = 2; delete v2.assessment
    for (const p of v2.points as Array<{ assessment: { decision?: unknown; summary: { eligibleForRecommendation: boolean } }; kind: string }>) { delete p.assessment.decision; p.kind = 'recommendation'; p.assessment.summary.eligibleForRecommendation = true }
    const text = JSON.stringify(v2)
    const parsed = parseSnapshot(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.snapshot.assessment).toEqual({ mode: 'strict', legacy: true, search: null })
      expect(renderToStaticMarkup(<Loaded s={parsed.snapshot} />)).toContain('legacy snapshot')
    }
    expect(text).toBe(JSON.stringify(v2)) // parse did not touch its input
    expect(validateSnapshot({ ...v2, schemaVersion: 1 })).toMatchObject({ ok: false, kind: 'unsupported-version' })
    expect(validateSnapshot({ ...v2, schemaVersion: 4 })).toMatchObject({ ok: false, kind: 'unsupported-version' })
  })
  it('rejects a point whose decision mode differs from the snapshot, and a snapshot with a damaged mode block', () => {
    const bad = structuredClone(snap); bad.assessment.mode = 'strict'
    expect(validateSnapshot(bad)).toMatchObject({ ok: false, error: expect.stringMatching(/another mode/) })
    const noMode = JSON.parse(serializeSnapshot(snap)) as Record<string, unknown>; noMode.assessment = { mode: 'x', legacy: false, search: null }
    expect(validateSnapshot(noMode)).toMatchObject({ ok: false })
  })
  it('refuses to build a snapshot when a search result lost its detail data', () => {
    const t = structuredClone(task); if (t.status === 'done') delete t.result.pointData![t.result.search!.results[0].siteId]
    expect(buildSnapshot({ task: t, input, settings, customs: [], maxCustom: 9, snapshotId: newSnapshotId(), nowMs: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Detail data/) })
  })
})
