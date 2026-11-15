// Convert a LOLA cylindrical GDR (LDEM_<ppd>_FLOAT.IMG) into the compact format used by src/physics/dem.ts:
//   <out>/ldem_<ppd>.bin   raw little-endian int16 heights in metres above the 1737.4 km reference sphere
//   <out>/ldem_<ppd>.json  grid metadata
//
// Usage: node tools/buildDem.mjs <ppd> [outDir]      (ppd = 4 or 16; downloads from the PDS Geosciences Node)
// Source: LRO LOLA GDR, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/
// Layout (from the PDS label): row 0 is +90 deg latitude, column 0 is 0 deg east longitude, east positive,
// pixel centres at half-pixel offsets, float32 little-endian (PC_REAL), kilometres relative to the reference sphere.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ppd = Number(process.argv[2])
const outDir = process.argv[3] ?? 'public/data/lola'
if (![4, 16].includes(ppd)) throw new Error('ppd must be 4 or 16')

const BASE = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/float_img'
const name = `ldem_${ppd}_float.img`
const cache = join('tools', '.cache')
mkdirSync(cache, { recursive: true })
const src = join(cache, name)
if (!existsSync(src)) {
  console.log(`downloading ${name}`)
  const res = await fetch(`${BASE}/${name}`)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  writeFileSync(src, Buffer.from(await res.arrayBuffer()))
}

const buf = readFileSync(src)
const width = 360 * ppd
const height = 180 * ppd
if (buf.length !== width * height * 4) throw new Error(`unexpected file size ${buf.length}`)
const f32 = new Float32Array(buf.buffer, buf.byteOffset, width * height)
const out = new Int16Array(width * height)
let min = Infinity
let max = -Infinity
for (let i = 0; i < f32.length; i++) {
  const m = Math.round(f32[i] * 1000)
  if (!Number.isFinite(m) || m < -32768 || m > 32767) throw new Error(`value out of int16 range at ${i}: ${f32[i]} km`)
  out[i] = m
  min = Math.min(min, m)
  max = Math.max(max, m)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `ldem_${ppd}.bin`), Buffer.from(out.buffer))
writeFileSync(
  join(outDir, `ldem_${ppd}.json`),
  JSON.stringify({
    width, height, ppd,
    radiusKm: 1737.4,
    unit: 'm',
    minM: min, maxM: max,
    source: `LRO LOLA GDR LDEM_${ppd} (PDS Geosciences Node)`,
  }, null, 2) + '\n',
)
console.log(`wrote ${outDir}/ldem_${ppd}.bin (${(out.byteLength / 1e6).toFixed(1)} MB), heights ${min}..${max} m`)
