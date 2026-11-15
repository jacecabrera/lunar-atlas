// Terrain horizon from several elevation sources (near, mid and far field), with coverage and an uncertainty
// estimate per azimuth. Generalises dem.horizonProfile, which works on one global grid.
//
// Geometry: the observer is at radius r0 from the Moon's centre (reference radius + ground elevation + observer
// height). A sample at great-circle angle theta along azimuth az, with ground elevation h, is at radius
// r1 = R + h. Its elevation angle above the observer's horizontal plane is atan2(r1 cos(theta) - r0, r1 sin(theta)):
// exact on the sphere, so the Moon's curvature is included and negative horizons are kept, not clipped to 0.
import { destination } from './dem'

const DEG = Math.PI / 180

export type HeightSource = {
  id: string
  /** Distance band this source is preferred in, km from the site (along the reference sphere). */
  minKm: number
  maxKm: number
  /** Sampling step along the ray inside the band, km (typically half a pixel). */
  stepKm: number
  /** Ground elevation in metres above the reference sphere, or null for no data / outside coverage. */
  sample: (latDeg: number, lonDeg: number) => number | null
  /** 1-sigma vertical precision, m, for the uncertainty estimate; null when unknown. */
  sigmaM: number | null
  /**
   * Smallest distance at which this source may stand in for a finer one that has no data. A coarse grid close to
   * the observer turns a small vertical offset between products into a false ridge (seen at Apollo 16 before this
   * rule: a 3.4 m SLDEM/NAC offset sampled 45 m from the site gave a ~4 deg horizon), so fallback starts only a few
   * of its own pixels away. Default 0.
   */
  fallbackMinKm?: number
}

export type CastOptions = {
  latDeg: number
  lonDeg: number
  /** Observer distance from the Moon's centre, km. */
  observerRadiusKm: number
  referenceRadiusKm: number
  azimuthStepDeg: number
  startAzimuthDeg?: number
  /** First sample distance, km: avoids the site's own pixel and footprint-scale noise (self-occlusion). */
  nearStartKm: number
  maxRangeKm: number
  /** Runs of missing samples up to this length are skipped (counted); longer runs make the azimuth a lower bound. */
  maxSkippedGapKm?: number
}

export type CastAzimuth = {
  elevationDeg: number
  /** 'complete': every sample to maxRangeKm had data. 'lower-bound': a gap or coverage end was met. */
  status: 'complete' | 'lower-bound'
  /** Distance up to which data were continuous, km. */
  coveredToKm: number
  /** Distance and source of the sample that set the horizon. */
  governingKm: number | null
  governingSource: string | null
  /** atan(sqrt(2) sigma / d) for the governing sample, degrees; null when its sigma is unknown. */
  uncertaintyDeg: number | null
  /** Samples taken from a coarser source because the preferred one had no data. */
  fallbackSamples: number
  /** Missing samples skipped inside short gaps (see maxSkippedGapKm). */
  skippedSamples: number
}

export type CastResult = { azimuths: CastAzimuth[]; samplesEvaluated: number; elapsedMs: number }

/**
 * Sources are tried in array order at each distance: the first whose band contains the distance is preferred, and
 * later sources whose coverage includes the point act as fallbacks (coarser data, counted in fallbackSamples).
 */
export function castHorizon(sources: HeightSource[], o: CastOptions): CastResult {
  if (!(o.azimuthStepDeg > 0) || Math.abs(Math.round(360 / o.azimuthStepDeg) * o.azimuthStepDeg - 360) > 1e-9) {
    throw new RangeError(`azimuthStepDeg must divide 360, got ${o.azimuthStepDeg}`)
  }
  if (!(o.nearStartKm > 0) || !(o.maxRangeKm > o.nearStartKm)) throw new RangeError('need 0 < nearStartKm < maxRangeKm')
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const R = o.referenceRadiusKm
  const r0 = o.observerRadiusKm
  // Distances to sample: each band at its own step, clipped to [nearStart, maxRange].
  const steps: { d: number; preferred: number }[] = []
  sources.forEach((s, i) => {
    const a = Math.max(s.minKm, o.nearStartKm)
    const b = Math.min(s.maxKm, o.maxRangeKm)
    for (let d = a; d < b - 1e-12; d += s.stepKm) steps.push({ d, preferred: i })
  })
  steps.push({ d: o.maxRangeKm, preferred: sources.length - 1 })
  steps.sort((x, y) => x.d - y.d)

  const n = Math.round(360 / o.azimuthStepDeg)
  const out: CastAzimuth[] = []
  let evaluated = 0
  for (let k = 0; k < n; k++) {
    const az = (o.startAzimuthDeg ?? 0) + k * o.azimuthStepDeg
    let best = -90
    let govKm: number | null = null
    let govSrc: string | null = null
    let govSigma: number | null = null
    let covered = o.nearStartKm
    let gap = false
    let fallback = 0
    let skipped = 0
    let gapStart: number | null = null
    let pendingSkips = 0
    for (const { d, preferred } of steps) {
      const theta = d / R
      const q = destination(o.latDeg, o.lonDeg, az, theta)
      // destination() does not wrap longitude (179.99 E plus 0.06 gives 180.05); normalise so no source has to.
      const p = { lat: q.lat, lon: ((((q.lon + 180) % 360) + 360) % 360) - 180 }
      let h: number | null = null
      let used = -1
      for (let i = preferred; i < sources.length && h === null; i++) {
        if (i !== preferred && d < (sources[i].fallbackMinKm ?? 0)) continue
        h = sources[i].sample(p.lat, p.lon)
        if (h !== null) used = i
      }
      evaluated++
      if (h === null) {
        if (gapStart === null) gapStart = d
        pendingSkips++
        if (d - gapStart > (o.maxSkippedGapKm ?? 0)) gap = true
        continue
      }
      if (gapStart !== null) {
        if (!gap) skipped += pendingSkips
        gapStart = null
        pendingSkips = 0
      }
      if (used !== preferred) fallback++
      if (!gap) covered = d
      const r1 = R + h / 1000
      const e = Math.atan2(r1 * Math.cos(theta) - r0, r1 * Math.sin(theta)) / DEG
      if (e > best) {
        best = e
        govKm = d
        govSrc = sources[used].id
        govSigma = sources[used].sigmaM
      }
    }
    if (gapStart !== null) gap = true
    out.push({
      elevationDeg: best,
      status: gap ? 'lower-bound' : 'complete',
      coveredToKm: gap ? covered : o.maxRangeKm,
      governingKm: govKm,
      governingSource: govSrc,
      uncertaintyDeg: govKm !== null && govSigma !== null ? Math.atan((Math.SQRT2 * govSigma) / (govKm * 1000)) / DEG : null,
      fallbackSamples: fallback,
      skippedSamples: skipped,
    })
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return { azimuths: out, samplesEvaluated: evaluated, elapsedMs: t1 - t0 }
}
