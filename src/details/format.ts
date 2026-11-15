// Formatting for the details page (step 22). UTC only. A missing value is "N/A" with its reason, never 0.
import type { Quantity } from '../sim/assessment'

export const utc = (ms: number) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`
export const utcShort = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)

/** "2 d 3 h 4 min", "3 h 20 min", "12 min 5 s", "8 s"; 0 stays "0 s" (a real zero). */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'N/A'
  let s = Math.round(ms / 1000)
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const parts: string[] = []
  if (d) parts.push(`${d} d`)
  if (h) parts.push(`${h} h`)
  if (m && !d) parts.push(`${m} min`)
  if (s && !d && !h) parts.push(`${s} s`)
  return parts.length ? parts.join(' ') : '0 s'
}

export type Shown = { ok: true; text: string; raw: number } | { ok: false; text: 'N/A'; reason: string }

/** A statistics Quantity as text: value with unit, or N/A with the reason it is not determined. */
export function show(q: Quantity): Shown {
  if (q.value === null) return { ok: false, text: 'N/A', reason: q.reason }
  if (q.unit === 'ms') return { ok: true, text: duration(q.value), raw: q.value }
  if (q.unit === '1') return { ok: true, text: `${(q.value * 100).toFixed(1)} %`, raw: q.value }
  if (q.unit === 'deg') return { ok: true, text: `${q.value.toFixed(2)}°`, raw: q.value } // negative elevations are kept
  return { ok: true, text: `${q.value} ${q.unit}`, raw: q.value }
}
