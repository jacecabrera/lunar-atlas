// The formal footprint assessment of the 12 real catalogue candidates, from the published terrain-v1 data.
// The expectations record what the current evidence supports; they are not targets to tune the rules towards.
import { describe, expect, it } from 'vitest'
import register from '../../sources.md?raw'
import { loadCandidateCatalog } from './catalog'
import { defaultAdvancedSettings } from './defaults'
import { footprintConfig } from './footprint'
import { assessCandidateFootprint, EVIDENCE_SOURCE_VERIFICATION } from './footprintEvidence'
import { TerrainLoadError } from './siteTerrain'
import { diskTerrainStore } from './testing/publishedTerrain'

const catalog = loadCandidateCatalog()
const cfg = footprintConfig(defaultAdvancedSettings())

describe('footprint evidence sources', () => {
  it('carry the verification status recorded in sources.md', () => {
    for (const [id, status] of Object.entries(EVIDENCE_SOURCE_VERIFICATION)) {
      const row = register.split('\n').find((l) => l.startsWith(`| \`${id}\` |`))
      expect(row, id).toBeDefined()
      expect(row!.split(' | ')[4], id).toBe(status)
    }
  })
})

describe('12 catalogue candidates (formal entry, published terrain)', async () => {
  const store = diskTerrainStore()
  const results = Object.fromEntries(await Promise.all(catalog.candidates.map(async (c) => [c.id, assessCandidateFootprint(c, catalog, await store.load(c.id), cfg)] as const)))
  const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code)

  it('never passes slope or obstacles: 2-5 m DTMs cannot resolve a 3 m footprint or 0.3 m obstacles', () => {
    for (const [id, r] of Object.entries(results)) {
      expect(r.slope.status, id).toBe('unknown')
      expect(codes(r.slope), id).toContain('slope-dtm-too-coarse')
      expect(r.obstacles.status, id).toBe('unknown')
      expect(codes(r.obstacles), id).toEqual(expect.arrayContaining(['obstacle-no-survey', 'obstacle-dtm-too-coarse']))
      expect(r.data.status, id).toBe('unknown')
      expect(r.terrain.status, id).not.toBe('pass')
    }
  })

  it('confirms a hardware overlap only where verified dimensions and the position error support it', () => {
    const status = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.hazards.overlaps[0].status]))
    // Apollo 11: verified NSSDCA dimensions (inscribed half-width 1.94 m) and 0.3 m position error (x3 = 0.9 m).
    expect(status['apollo-11']).toBe('confirmed-overlap')
    expect(results['apollo-11'].terrain.status).toBe('fail')
    expect(codes(results['apollo-11'].terrain)).toContain('slope-dtm-too-coarse') // other unknowns are kept
    // Everywhere else the dimensions are unverified (or only tripod reach is known): possible, never assumed.
    for (const id of Object.keys(status).filter((x) => x !== 'apollo-11')) {
      expect(status[id], id).toBe('possible-overlap')
      expect(results[id].terrain.status, id).toBe('unknown')
    }
  })

  it('never treats catalogued nearby objects as confirmed overlaps (frames not reconciled)', () => {
    for (const r of Object.values(results)) for (const o of r.hazards.overlaps.slice(1)) expect(o.status).toBe('undetermined')
  })

  it('maps missing or failed terrain to unknown or error, never to fail on the terrain data', () => {
    const c = catalog.candidates.find((x) => x.id === 'luna-16')!
    expect(assessCandidateFootprint(c, catalog, null, cfg).slope.status).toBe('unknown')
    expect(assessCandidateFootprint(c, catalog, new TerrainLoadError('network', 'reset'), cfg).terrain.status).toBe('error')
  })
})
