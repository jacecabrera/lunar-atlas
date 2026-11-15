import { describe, expect, it } from 'vitest'
import catalogJson from '../data/lunar-candidate-catalog-v0.1.json'
import defaultsJson from '../data/lunar-mission-defaults-v0.1.json'
import register from '../../sources.md?raw'
import {
  parseCandidateCatalog, loadCandidateCatalog, toCandidateRecord, initialSiteAssessment, quantizationHalfStepM,
  surfaceDistanceM, decimalPlaces,
} from './catalog'

// Coordinates from the project reference table (NSSDCA, east positive), independent of the JSON under test.
const EXPECTED: Array<[string, number, number]> = [
  ['apollo-11', 0.67416, 23.47314], ['apollo-12', -3.0128, -23.4219], ['apollo-14', -3.64589, -17.47194],
  ['apollo-15', 26.13239, 3.6333], ['apollo-16', -8.9734, 15.5011], ['apollo-17', 20.1911, 30.7723],
  ['surveyor-7', -40.9812, -11.5127], ['luna-16', -0.5137, 56.3638], ['change-3', 44.1214, -19.5117],
  ['change-4', -45.4561, 177.5885], ['change-5', 43.0576, -51.9161], ['chandrayaan-3', -69.3741, 32.32],
]


// Path-based edits on a deep copy of the JSON, so the negative tests need no `any`.
type Node = Record<string, unknown>
const walk = (root: unknown, path: string[]): Node => path.reduce<Node>((n, k) => n[k] as Node, root as Node)
const put = (root: unknown, path: string, value: unknown) => { const p = path.split('/'); walk(root, p.slice(0, -1))[p.at(-1)!] = value }
const get = (root: unknown, path: string) => { const p = path.split('/'); return walk(root, p.slice(0, -1))[p.at(-1)!] }
const errorsOf = (mutate: (c: unknown) => void) => {
  const c = structuredClone(catalogJson)
  mutate(c)
  const r = parseCandidateCatalog(c)
  return r.ok ? [] : r.errors
}

describe('candidate catalog', () => {
  const catalog = loadCandidateCatalog()

  it('registers exactly the twelve historical points with the reference coordinates', () => {
    expect(catalog.candidates.map((c) => [c.id, c.coordinate.lat, c.coordinate.lon])).toEqual(EXPECTED)
    expect(new Set(catalog.candidates.map((c) => c.id)).size).toBe(12)
  })

  it('keeps the printed precision that a number would lose', () => {
    const a15 = catalog.candidates.find((c) => c.id === 'apollo-15')!.coordinate
    expect(a15.lon).toBe(3.6333)
    expect(a15.lonText).toBe('3.63330')
    expect(decimalPlaces(a15.lonText)).toBe(5)
    expect(a15.sourceText).toBe('26.13239 N, 3.63330 E')
    const a12 = catalog.candidates.find((c) => c.id === 'apollo-12')!.coordinate
    expect([a12.lonText, a12.lonEast360Text, a12.sourceText]).toEqual(['-23.4219', '336.5781', '3.0128 S, 23.4219 W'])
  })

  it('derives rounding half-steps from decimals and labels them as derived', () => {
    const ch3 = quantizationHalfStepM(catalog.candidates.at(-1)!.coordinate)
    expect(ch3.eastWestM).toBeGreaterThan(50)
    expect(ch3.eastWestM).toBeLessThan(56) // two decimals of longitude at 69 S
    const a11 = quantizationHalfStepM(catalog.candidates[0].coordinate)
    expect(a11.northSouthM).toBeCloseTo(0.15, 1)
  })

  it('stores other coordinates beside the source coordinate and never over it', () => {
    for (const c of catalog.candidates) {
      expect(c.alternateCoordinates).toHaveLength(1)
      const alt = c.alternateCoordinates[0]
      expect(alt.uncertaintyStatistic).toBe('unknown')
      expect(alt.frameReconciled).toBe(false)
    }
    const offset = (id: string) => {
      const c = catalog.candidates.find((x) => x.id === id)!
      return surfaceDistanceM(c.coordinate, c.alternateCoordinates[0])
    }
    expect(offset('apollo-11')).toBeLessThan(0.01)
    expect(offset('surveyor-7')).toBeCloseTo(3.0, 0)
    expect(offset('change-4')).toBeCloseTo(3.7, 0)
    expect(offset('chandrayaan-3')).toBeCloseTo(14.2, 0)
    // The catalogue coordinate is still the NSSDCA value for the three that differ.
    expect(catalog.candidates.find((c) => c.id === 'chandrayaan-3')!.coordinate.lonText).toBe('32.32')
  })

  it('separates hardware existence, possible overlap and direct evidence', () => {
    const level = (id: string) => catalog.candidates.find((c) => c.id === id)!.hardware.footprintOverlap.level
    for (const id of ['apollo-11', 'apollo-12', 'apollo-14', 'apollo-15', 'apollo-16', 'apollo-17']) expect(level(id)).toBe('geometric-derivation')
    for (const id of ['surveyor-7', 'luna-16', 'change-3', 'change-4', 'change-5']) expect(level(id)).toBe('possible')
    expect(level('chandrayaan-3')).toBe('insufficient-data')
    // No point has an image-registered overlap yet.
    expect(catalog.candidates.some((c) => c.hardware.footprintOverlap.level === 'direct-evidence')).toBe(false)
  })

  it('uses null, not 0, for unknown hardware dimensions', () => {
    const dims = (id: string) => catalog.candidates.find((c) => c.id === id)!.hardware.dimensionsM
    expect(dims('apollo-11')).toMatchObject({ widthM: 4.2, footpadSpanM: 9.4, groundClearanceM: 1.5, heightM: null })
    expect(dims('surveyor-7')).toMatchObject({ heightM: 3, footpadReachFromCenterM: 4.3, widthM: null })
    expect(dims('luna-16')).toBeNull()
    for (const c of catalog.candidates) {
      for (const v of Object.values(c.hardware.dimensionsM ?? {})) expect(v === null || v > 0).toBe(true)
    }
  })

  it('records every point as covered by at least one NAC DTM, with the sampled values', () => {
    for (const c of catalog.candidates) {
      expect(c.terrain.localDtms.length).toBeGreaterThan(0)
      for (const d of c.terrain.localDtms) {
        expect(d.coverage.status).toBe('covered')
        expect(d.pointSample.windowMissingElevationCount).toBeGreaterThanOrEqual(0)
        expect(d.pointSample.windowValidMatchCount).toBeLessThanOrEqual(d.pointSample.windowPixelCount)
      }
    }
    expect(catalog.candidates.reduce((a, c) => a + c.terrain.localDtms.length, 0)).toBe(17)
  })

  it('keeps data quality caveats: suspicious centre pixels and unconfirmed confidence legends', () => {
    const dtm = (id: string, name: string) => catalog.candidates.find((c) => c.id === id)!.terrain.localDtms.find((d) => d.dtmName === name)!
    expect(dtm('apollo-14', 'APOLLO14').pointSample.centerConfidenceCode).toBe(3)
    expect(dtm('apollo-16', 'APOLLO16').pointSample.centerConfidenceCode).toBe(3)
    expect(dtm('apollo-15', 'APOLLO15').pointSample.nonStandardCodesObserved).toBe(true)
    expect(dtm('change-4', 'CHANGE4').pointSample.nonStandardCodesObserved).toBe(true)
    expect(dtm('luna-16', 'LUNA16').lolaOffsetsM.lat).toBeCloseTo(28.84, 2)
    expect(dtm('chandrayaan-3', 'VIKRAMSITE1').projection).toBe('Polar Stereographic')
  })

  it('records the regional product that does and does not cover each point', () => {
    const reg = (id: string, product: string) => catalog.candidates.find((c) => c.id === id)!.terrain.regionalProducts.find((r) => r.productId === product)!
    expect(reg('chandrayaan-3', 'sldem2015').coverage.status).toBe('not-covered')
    expect(reg('chandrayaan-3', 'lola-ldem-60s-60m').coverage.status).toBe('covered')
    expect(reg('apollo-17', 'sldem2015').qualityResidualRmsM).toBeCloseTo(6.17, 2)
    expect(reg('apollo-11', 'sldem2013').coverage.status).toBe('unverified')
  })

  it('claims no product that supports 3 m footprint slope or 0.3 m obstacles', () => {
    for (const p of catalog.terrainProducts) {
      expect(p.uses.footprintSlope).not.toBe('supported')
      expect(p.uses.obstacle).not.toBe('supported')
    }
    expect(catalog.terrainProducts.find((p) => p.id === 'moon-trek-tiles')!.uses.regionalTerrain).toBe('not-supported')
  })

  it('keeps unknown versions and accuracies as null instead of inventing numbers', () => {
    const p = (id: string) => catalog.terrainProducts.find((x) => x.id === id)!
    expect(p('ldem-4').version).toBeNull()
    expect(p('lola-ldem-512').verticalAccuracy.value).toBeNull()
    expect(p('ohrc-dem-isro').verticalAccuracy.value).toBeNull()
    expect(p('nac-dtm').gridSpacingM).toBeNull()
  })

  it('distinguishes unreleased, login-required and open products', () => {
    const state = (id: string) => catalog.terrainProducts.find((x) => x.id === id)!.availability.state
    expect(state('ce2-ccd-dem')).toBe('login-required')
    expect(state('ohrc-dem-isro')).toBe('reported-no-public-release-found')
    expect(state('ohrc-dem-independent')).toBe('announced-not-yet-released')
    expect(state('nac-dtm')).toBe('open-verified')
  })

  it('gives every candidate the unknown initial state: not allowed-or-denied, never eligible', () => {
    for (const c of catalog.candidates) {
      const a = initialSiteAssessment(c)
      expect(a.summary.landingAllowed).toBeNull()
      expect(a.summary.eligibleForRecommendation).toBe(false)
      expect(a.summary.failed).toEqual([])
      expect(a.summary.reasons.every((r) => r.code === 'not-evaluated')).toBe(true)
    }
  })

  it('adapts to the CandidateRecord contract without moving the coordinate', () => {
    const c = catalog.candidates.find((x) => x.id === 'chandrayaan-3')!
    const r = toCandidateRecord(c, catalog)
    expect([r.lat, r.lon, r.origin]).toEqual([-69.3741, 32.32, 'historical'])
    expect(r.frame).toContain('DE421')
    expect(r.source?.id).toBe('SRC-NSSDCA-ARTIFACTS')
  })

  it('has a fixed identity that does not depend on when it is loaded', () => {
    expect(catalog.catalogId).toBe('historical-reference-sites')
    expect(catalog.dataVersion).toBe('v0.1')
    expect(loadCandidateCatalog()).toBe(catalog)
  })
})

describe('catalog validation rejects bad data', () => {
  it('rejects duplicate candidate IDs and duplicate product IDs', () => {
    expect(errorsOf((c) => put(c, 'candidates/1/id', get(c, 'candidates/0/id'))).join()).toMatch(/duplicate candidate ID/)
    expect(errorsOf((c) => put(c, 'terrainProducts/1/id', get(c, 'terrainProducts/0/id'))).join()).toMatch(/duplicate terrain product ID/)
  })
  it('rejects out-of-range and non-finite coordinates', () => {
    expect(errorsOf((c) => put(c, 'candidates/0/coordinate/lat', 91)).join()).toMatch(/lat/)
    expect(errorsOf((c) => put(c, 'candidates/0/coordinate/lon', 181)).join()).toMatch(/lon/)
    expect(errorsOf((c) => put(c, 'candidates/0/coordinate/lat', null)).join()).toMatch(/lat/)
    expect(errorsOf((c) => put(c, 'candidates/0/alternateCoordinates/0/lon', 999)).join()).toMatch(/finite coordinates/)
  })
  it('rejects a number that disagrees with its printed text, and lost decimals', () => {
    expect(errorsOf((c) => put(c, 'candidates/0/coordinate/latText', '0.67417')).join()).toMatch(/latText/)
    expect(errorsOf((c) => put(c, 'candidates/3/coordinate/lonText', '3.6333')).join()).toMatch(/decimals/)
    expect(errorsOf((c) => put(c, 'candidates/1/coordinate/sourceText', '3.0128 N, 23.4219 W')).join()).toMatch(/sourceText/)
  })
  it('rejects pre-filled evaluation results anywhere in the file', () => {
    expect(errorsOf((c) => put(c, 'candidates/0/landingAllowed', false)).join()).toMatch(/landingAllowed/)
    expect(errorsOf((c) => put(c, 'candidates/0/terrain/eligibleForRecommendation', true)).join()).toMatch(/eligibleForRecommendation/)
    expect(errorsOf((c) => put(c, 'candidates/0/score', 80)).join()).toMatch(/score/)
  })
  it('rejects zero or negative dimensions and an invented uncertainty meaning', () => {
    expect(errorsOf((c) => put(c, 'candidates/0/hardware/dimensionsM/heightM', 0)).join()).toMatch(/heightM/)
    expect(errorsOf((c) => put(c, 'candidates/0/alternateCoordinates/0/uncertaintyStatistic', '1-sigma')).join()).toMatch(/uncertaintyStatistic/)
  })
  it('rejects dimensions without a source, and missing or malformed source IDs', () => {
    expect(errorsOf((c) => put(c, 'candidates/0/hardware/dimensionsSourceIds', [])).join()).toMatch(/no source/)
    expect(errorsOf((c) => put(c, 'candidates/0/coordinate/sourceId', 'nssdca')).join()).toMatch(/sourceId/)
    expect(errorsOf((c) => put(c, 'terrainProducts/0/sourceIds', [])).join()).toMatch(/sourceIds/)
  })
  it('rejects references to unknown products and inconsistent confidence counts', () => {
    expect(errorsOf((c) => put(c, 'candidates/0/terrain/regionalProducts/0/productId', 'nope')).join()).toMatch(/unknown product/)
    expect(errorsOf((c) => put(c, 'candidates/0/terrain/localDtms/0/pointSample/windowPixelCount', 440)).join()).toMatch(/pointSample/)
  })
  it('rejects a wrong schema and unsupported versions', () => {
    expect(parseCandidateCatalog(null).ok).toBe(false)
    expect(errorsOf((c) => put(c, 'schema', 'x')).join()).toMatch(/schema/)
    expect(errorsOf((c) => put(c, 'schemaVersion', 2)).join()).toMatch(/schemaVersion/)
  })
})

describe('source IDs used by the configuration files', () => {
  const registered = new Set([...register.matchAll(/^\| `((?:SRC|ASM|REQ)-[A-Z0-9-]+)` \|/gm)].map((m) => m[1]))

  const used = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => used(x, out))
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (['sourceId', 'sourceIds', 'assumptionIds', 'dimensionsSourceIds', 'measuredDimensionsSourceIds'].includes(k)) [x].flat().forEach((id) => out.add(String(id)))
        else used(x, out)
      }
    }
    return out
  }

  it('are all defined in the source register in sources.md', () => {
    const ids = [...used(catalogJson), ...used(defaultsJson)]
    expect(ids.length).toBeGreaterThan(20)
    expect(ids.filter((id) => !registered.has(id))).toEqual([])
  })
  it('register entries have unique IDs', () => {
    const all = [...register.matchAll(/^\| `((?:SRC|ASM|REQ)-[A-Z0-9-]+)` \|/gm)].map((m) => m[1])
    expect(new Set(all).size).toBe(all.length)
  })
})
