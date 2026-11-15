// Settings of the snapshot as shown on the details page (step 22): a short summary plus the full flattened table with the
// units of the bundled preset. Read from the snapshot only.
import type { DetailSnapshot } from '../sim/snapshot'
import { duration, utc } from './format'

export type SettingRow = { key: string; value: string; unit: string }

function flatten(v: unknown, prefix: string, out: Array<[string, unknown]>) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'provenance') flatten(x, prefix ? `${prefix}.${k}` : k, out)
  } else out.push([prefix, v])
}

export function settingRows(snap: DetailSnapshot): SettingRow[] {
  const flat: Array<[string, unknown]> = []
  flatten(snap.settings, '', flat)
  return flat.map(([key, v]) => ({ key, value: Array.isArray(v) ? v.join(', ') : String(v), unit: snap.preset?.parameters[key]?.unit ?? '' }))
}

export function summaryLines(snap: DetailSnapshot): string[] {
  const s = snap.settings as unknown as Record<string, number>
  const i = snap.input
  return [
    `Landing Time ${utc(i.landingTimeMs)}`,
    `Mission length ${duration(i.durationMs)} (ends ${utc(i.landingTimeMs + i.durationMs)})`,
    `Launch site ${i.launchSite.lat}°, ${i.launchSite.lon}°`,
    `Earth minimum elevation ${s.earthMinElevationDeg}°`,
    `Footprint ${s.footprintDiameterM} m, slope limit ${s.slopeLimitDeg}°, obstacle limit ${s.obstacleLimitM} m`,
    `Settings preset ${snap.preset ? `${snap.preset.presetId}@${snap.preset.dataVersion}` : 'n/a'}`,
  ]
}
