// Footprint-scale terrain metrics on an elevation sampler: slope over a stated baseline and local relief above a
// fitted plane. Geometry only; deciding whether the data can support a conclusion is done in sim/footprint.ts.
//
// Offsets of a few metres are mapped to latitude/longitude on the local tangent plane of the 1737.4 km sphere
// (error ~ d^3 / R^2, below a micrometre at 10 m).

const R_M = 1_737_400
const DEG = Math.PI / 180

export type HeightSampler = (latDeg: number, lonDeg: number) => number | null

export function offsetLatLon(latDeg: number, lonDeg: number, eastM: number, northM: number): { lat: number; lon: number } {
  const lat = latDeg + northM / R_M / DEG
  const lon = lonDeg + eastM / (R_M * Math.cos(latDeg * DEG)) / DEG
  return { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 }
}

/**
 * Slope magnitude at a point from central differences over `baselineM` (east-west and north-south), deg.
 * Null when any of the four samples is missing. The baseline must not be shorter than the data resolution; that
 * check belongs to the caller (interpolating inside a cell adds no terrain information).
 */
export function slopeAt(h: HeightSampler, latDeg: number, lonDeg: number, eastM: number, northM: number, baselineM: number): number | null {
  const d = baselineM / 2
  const at = (de: number, dn: number) => { const p = offsetLatLon(latDeg, lonDeg, eastM + de, northM + dn); return h(p.lat, p.lon) }
  const e1 = at(d, 0), e0 = at(-d, 0), n1 = at(0, d), n0 = at(0, -d)
  if (e1 === null || e0 === null || n1 === null || n0 === null) return null
  const gx = (e1 - e0) / baselineM
  const gy = (n1 - n0) / baselineM
  return Math.atan(Math.hypot(gx, gy)) / DEG
}

export type DiscSample = { eastM: number; northM: number; z: number | null; slopeDeg: number | null; code: number | null }

/** Regular samples (spacing `stepM`) inside a disc of radius `radiusM` around the offset (0, 0). */
export function sampleDisc(
  h: HeightSampler, code: ((lat: number, lon: number) => number | null) | null,
  latDeg: number, lonDeg: number, radiusM: number, stepM: number, baselineM: number,
): DiscSample[] {
  const out: DiscSample[] = []
  const n = Math.ceil(radiusM / stepM)
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const e = i * stepM, nn = j * stepM
      if (Math.hypot(e, nn) > radiusM + 1e-9) continue
      const p = offsetLatLon(latDeg, lonDeg, e, nn)
      out.push({ eastM: e, northM: nn, z: h(p.lat, p.lon), slopeDeg: slopeAt(h, latDeg, lonDeg, e, nn, baselineM), code: code ? code(p.lat, p.lon) : null })
    }
  }
  return out
}

/** Largest height above the least-squares plane through the samples (protrusions only), m; null if < 3 samples. */
export function reliefAbovePlane(samples: Array<{ eastM: number; northM: number; z: number }>): number | null {
  const n = samples.length
  if (n < 3) return null
  // Normal equations for z = a + b e + c n.
  let se = 0, sn = 0, sz = 0, see = 0, snn = 0, sen = 0, sez = 0, snz = 0
  for (const s of samples) {
    se += s.eastM; sn += s.northM; sz += s.z; see += s.eastM ** 2; snn += s.northM ** 2; sen += s.eastM * s.northM; sez += s.eastM * s.z; snz += s.northM * s.z
  }
  const m = [[n, se, sn], [se, see, sen], [sn, sen, snn]]
  const v = [sz, sez, snz]
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  const D = det(m)
  if (Math.abs(D) < 1e-12) return null
  const col = (k: number) => m.map((row, r) => row.map((x, c) => (c === k ? v[r] : x)))
  const a = det(col(0)) / D, b = det(col(1)) / D, c = det(col(2)) / D
  let max = -Infinity
  for (const s of samples) max = Math.max(max, s.z - (a + b * s.eastM + c * s.northM))
  return Math.max(0, max)
}
