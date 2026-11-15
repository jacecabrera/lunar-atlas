// Cut the LOLA LDEM_16 grid into the 30 deg x 30 deg tiles read by src/sim/globalTerrain.ts.
//   node tools/buildDem.mjs 16 tools/.cache/ldem16      # downloads ldem_16_float.img and writes ldem_16.bin (int16 metres)
//   node tools/buildGlobalTiles.mjs                     # writes public/data/terrain/global-v1/
// Each tile holds int16 samples with a 2-pixel margin, delta-coded by rows (see encodeTile) and deflate-raw compressed. The
// manifest records byte lengths and the FNV-1a checksum of the decoded int16 samples. Uses the same tile layout code as the app (Node strips the types).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { extractTile, encodeTile, tileSize, tilesAcross, tilesDown, GLOBAL_TERRAIN_VERSION } from '../src/sim/globalTerrain.ts'

const srcDir = process.argv[2] ?? 'tools/.cache/ldem16'
const outDir = process.argv[3] ?? 'public/data/terrain/global-v1'
const meta = JSON.parse(readFileSync(join(srcDir, 'ldem_16.json'), 'utf8'))
const bin = readFileSync(join(srcDir, 'ldem_16.bin'))
const full = new Int16Array(bin.buffer, bin.byteOffset, bin.length / 2)
const layout = { ppd: meta.ppd, radiusKm: meta.radiusKm, tileDeg: 30, marginPx: 2 }
if (full.length !== 360 * layout.ppd * 180 * layout.ppd) throw new Error('unexpected grid size')

function fnv1a32(bytes) { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') }

mkdirSync(join(outDir, 'tiles'), { recursive: true })
const tiles = []
let total = 0
for (let tj = 0; tj < tilesDown(layout); tj++) for (let ti = 0; ti < tilesAcross(layout); ti++) {
  const t = extractTile(full, layout, ti, tj)
  const samples = Buffer.from(t.buffer, t.byteOffset, t.byteLength)
  const raw = Buffer.from(encodeTile(t, tileSize(layout)))
  const z = deflateRawSync(raw, { level: 9 })
  const path = `tiles/t-${ti}-${tj}.i16.z`
  writeFileSync(join(outDir, path), z)
  tiles.push({ ti, tj, path, bytes: z.length, rawBytes: raw.length, fnv1a32: fnv1a32(samples) })
  total += z.length
}
const manifest = {
  schema: 'lunar-navigator.global-terrain', schemaVersion: 1, dataVersion: GLOBAL_TERRAIN_VERSION,
  product: {
    id: 'LDEM_16', sourceId: 'SRC-LOLA-GDR-CYL',
    url: 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/float_img/ldem_16_float.img',
    frame: 'MEAN EARTH/POLAR AXIS OF DE421 (PDS label)', frameVerification: 'label-stated; same product family and frame as the LDEM_4 preview checked against SLDEM2015 in step 07', verticalUnit: 'm',
  },
  layout, quantisationM: 1, heightRangeM: [meta.minM, meta.maxM],
  generator: { tool: 'tools/buildGlobalTiles.mjs', generatedAtUtc: new Date().toISOString() },
  tiles,
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
console.log(`wrote ${tiles.length} tiles, ${(total / 1e6).toFixed(1)} MB compressed, heights ${meta.minM}..${meta.maxM} m`)
