// runMissionJob (the Worker's calculation) on the published terrain, plus failure, retry and cancellation cases.
import { vi, describe, expect, it } from 'vitest'
import { runMissionJob, JobCancelled, JOB_PROTOCOL_VERSION } from './job'
import type { MissionJob, JobContext } from './job'
import { defaultAdvancedSettings } from './defaults'
import { loadCandidateCatalog } from './catalog'
import { CURRENT_MODEL_VERSIONS } from './task'
import { createSiteTerrainStore } from './siteTerrain'
import type { SiteTerrain } from './siteTerrain'
import { diskTerrainStore } from './testing/publishedTerrain'
import { missionTransits } from './candidateEvaluation'
// Real-ephemeris brute-force references in this file take 1-4 s alone and timed out at the 5 s default under
// parallel load; a run-time limit only, no numerical tolerance depends on it.
vi.setConfig({ testTimeout: 60_000 })


const catalog = loadCandidateCatalog()
const ids = catalog.candidates.map((c) => c.id)
const L = Date.UTC(2027, 0, 10)
const job = (over: Partial<MissionJob> = {}): MissionJob => ({
  protocol: JOB_PROTOCOL_VERSION, requestId: 'req-1', fingerprint: 'fp', versions: CURRENT_MODEL_VERSIONS,
  input: { landingTimeMs: L, durationMs: 3 * 86_400_000, launchSite: { lat: 28.5, lon: -80.6 } }, settings: defaultAdvancedSettings(),
  siteIds: ids, terrainBaseUrl: '/terrain/', ...over,
})
const ctx = (over: Partial<JobContext> = {}): JobContext => ({ terrain: diskTerrainStore(), isCancelled: () => false, progress: () => {}, yieldNow: async () => {}, ...over })

describe('a mission job on the 12 real candidates', async () => {
  const progress: string[] = []
  const r = await runMissionJob(job(), ctx({ progress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`) }))
  it('completes normally with zero recommendations and every reason kept', () => {
    expect(r.outcome).toBe('no-eligible-sites')
    expect(r.sites).toHaveLength(12)
    expect(r.evaluation!.excluded.physicalFail.map((x) => x.siteId)).toEqual(['change-4'])
    expect(r.evaluation!.excluded.insufficientData).toHaveLength(11)
    expect(r.evaluation!.excluded.serviceError).toEqual([])
    expect(r.transits).toEqual({}) // no recommended site: no transit estimate
    expect(r.runtime!.ttMinusUtcSecondsAtLanding).toBe(69.184)
    expect(progress).toContain('terrain:12/12')
    expect(progress).toContain('evaluate:12/12')
    expect(JSON.parse(JSON.stringify(r))).toEqual(r) // plain data
  })
  it('changing the launch site or the stay duration leaves the lunar assessment of the same window unchanged', async () => {
    const other = await runMissionJob(job({ input: { ...job().input, launchSite: { lat: -30, lon: 120 } } }), ctx())
    expect(other.sites).toEqual(r.sites)
    expect(other.recommendations).toEqual(r.recommendations)
  })
})

describe('terrain failures, retries and cancellation', () => {
  it('a failed terrain load is a service error for that site only; insufficient terrain stays unknown', async () => {
    const disk = diskTerrainStore()
    const failing = createSiteTerrainStore({ baseUrl: '/t/', fetcher: async (url) => { if (url.includes('apollo-11/')) throw new Error('connection reset'); return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } } })
    const store = { ...disk, load: (id: string) => (id === 'apollo-11' ? failing.load(id) : disk.load(id)) } as typeof disk
    const r = await runMissionJob(job({ siteIds: ['apollo-11', 'apollo-12'] }), ctx({ terrain: store }))
    const a11 = r.sites.find((s) => s.siteId === 'apollo-11')!
    expect(a11.conditions.terrain.status).toBe('error')
    expect(a11.conditions.terrain.reasons[0].code).toBe('terrain-network')
    expect(a11.summary.landingAllowed).toBeNull() // an error is not a physical failure
    const a12 = r.sites.find((s) => s.siteId === 'apollo-12')!
    expect(a12.conditions.terrain.status).toBe('unknown') // insufficient data
  })
  it('a network failure is not cached: the next job loads the site', async () => {
    let calls = 0
    const flaky = createSiteTerrainStore({ baseUrl: '/terrain/', fetcher: async (url) => {
      calls++
      if (calls === 1) throw new Error('offline')
      const fs = 'node:fs/promises'
      const { readFile } = (await import(/* @vite-ignore */ fs)) as { readFile: (p: string) => Promise<Uint8Array> }
      const b = await readFile(decodeURIComponent(new URL('../../public/data/terrain/v1/', import.meta.url).pathname) + url.replace('/terrain/', ''))
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
    } })
    const first = await runMissionJob(job({ siteIds: ['apollo-12'] }), ctx({ terrain: flaky }))
    expect(first.sites[0].conditions.terrain.status).toBe('error')
    const second = await runMissionJob(job({ siteIds: ['apollo-12'] }), ctx({ terrain: flaky }))
    expect(second.sites[0].conditions.terrain.status).toBe('unknown')
  })
  it('cancellation stops at the next yield', async () => {
    let n = 0
    await expect(runMissionJob(job(), ctx({ isCancelled: () => ++n > 3 }))).rejects.toBeInstanceOf(JobCancelled)
  })
  it('rejects an unknown protocol and an unknown site as task errors', async () => {
    await expect(runMissionJob(job({ protocol: 99 }), ctx())).rejects.toThrow(/protocol/)
    await expect(runMissionJob(job({ siteIds: ['nowhere'] }), ctx())).rejects.toThrow(/Unknown candidate/)
  })
})

describe('transit estimates in the task (SYNTHETIC terrain stub for the success path)', () => {
  const run = { candidate: catalog.candidates[0], terrain: { observerRadiusKm: () => 1735.47, elevation: { source: 'synthetic' } } as unknown as SiteTerrain }
  const input = job().input
  it('estimates recommended sites; the stay duration does not change it, the launch site does', () => {
    const a = missionTransits(['apollo-11'], [run], input, { transitSpeedKmPerS: 1.5 })['apollo-11']
    expect(a.status).toBe('ok')
    const longer = missionTransits(['apollo-11'], [run], { ...input, durationMs: 20 * 86_400_000 }, { transitSpeedKmPerS: 1.5 })['apollo-11']
    expect(longer.durationMs).toBe(a.durationMs)
    const moved = missionTransits(['apollo-11'], [run], { ...input, launchSite: { lat: -30, lon: 120 } }, { transitSpeedKmPerS: 1.5 })['apollo-11']
    expect(moved.durationMs).not.toBe(a.durationMs)
  })
  it('a site without terrain gets missing-elevation, never a 0 m default', () => {
    const r = missionTransits(['apollo-11'], [{ ...run, terrain: null }], input, { transitSpeedKmPerS: 1.5 })['apollo-11']
    expect(r).toMatchObject({ status: 'missing-elevation', durationMs: null })
  })
})
