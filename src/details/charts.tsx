import { useId } from 'react'
import type { CurvePoint, TimelineSegment } from './metrics'
import { utcShort } from './format'

// Charts of the details page (step 22): plain SVG, no interpolation across unknown time.
const W = 320
const STATE_FILL = { visible: '#e8c547', 'not-visible': '#2c3340', unknown: 'url(#hatch)' } as const

export function TimelineStrip({ label, segments, startMs, endMs, selectedMs, visibleName }: { label: string; segments: TimelineSegment[]; startMs: number; endMs: number; selectedMs: number; visibleName: string }) {
  const id = useId()
  const x = (t: number) => ((t - startMs) / (endMs - startMs)) * W
  const unknown = segments.filter((s) => s.state === 'unknown')
  return (
    <figure style={{ margin: '6px 0' }}>
      <figcaption style={{ fontSize: 12 }}>{label}</figcaption>
      <svg width="100%" viewBox={`0 0 ${W} 22`} role="img" aria-label={`${label}: ${visibleName}, not visible and unknown time over the mission window${unknown.length ? `; ${unknown.length} unknown interval(s)` : ''}`}>
        <defs>
          <pattern id={`${id}h`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#4a1d1d" /><rect width="3" height="6" fill="#d9534f" /></pattern>
        </defs>
        {segments.map((s, i) => <rect key={i} x={x(s.start)} y={2} width={Math.max(0.5, x(s.end) - x(s.start))} height={14} fill={s.state === 'unknown' ? `url(#${id}h)` : STATE_FILL[s.state]} data-state={s.state}><title>{`${s.state} ${utcShort(s.start)} to ${utcShort(s.end)} UTC`}</title></rect>)}
        {selectedMs >= startMs && selectedMs <= endMs && <line x1={x(selectedMs)} x2={x(selectedMs)} y1={0} y2={18} stroke="#8fd3ff" strokeWidth={1.5} />}
        <text x={0} y={21} fontSize={6} fill="#aaa">{utcShort(startMs)}</text>
        <text x={W} y={21} fontSize={6} fill="#aaa" textAnchor="end">{utcShort(endMs)} UTC</text>
      </svg>
    </figure>
  )
}

export function ElevationCurve({ points, startMs, endMs, selectedMs }: { points: CurvePoint[]; startMs: number; endMs: number; selectedMs: number }) {
  const H = 110, padL = 26, padB = 14
  const lo = Math.min(0, ...points.map((p) => p.elevationDeg)), hi = Math.max(0, ...points.map((p) => p.elevationDeg))
  const x = (t: number) => padL + ((t - startMs) / (endMs - startMs)) * (W - padL)
  const y = (e: number) => 4 + (1 - (e - lo) / Math.max(1e-9, hi - lo)) * (H - 4 - padB)
  // Polyline pieces: consecutive points whose visibility is known. An unknown sample ends the piece (no bridging) and is drawn hollow.
  const pieces: CurvePoint[][] = []
  let cur: CurvePoint[] = []
  for (const p of points) { if (p.sunlit === null) { if (cur.length) pieces.push(cur); cur = [] } else cur.push(p) }
  if (cur.length) pieces.push(cur)
  const unknown = points.filter((p) => p.sunlit === null)
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Sun centre elevation from ${hi.toFixed(1)}° to ${lo.toFixed(1)}° over the mission window; negative values are below the horizontal plane${unknown.length ? `; ${unknown.length} sample(s) with unknown visibility are not connected` : ''}`}>
      <line x1={padL} x2={W} y1={y(0)} y2={y(0)} stroke="#667" strokeDasharray="3 3" />
      <text x={2} y={y(0) + 3} fontSize={7} fill="#aaa">0°</text>
      <text x={2} y={10} fontSize={7} fill="#aaa">{hi.toFixed(0)}°</text>
      <text x={2} y={H - padB} fontSize={7} fill="#aaa">{lo.toFixed(0)}°</text>
      {pieces.map((pc, i) => pc.length > 1
        ? <polyline key={i} fill="none" stroke="#e8c547" strokeWidth={1.4} points={pc.map((p) => `${x(p.tMs).toFixed(1)},${y(p.elevationDeg).toFixed(1)}`).join(' ')} />
        : <circle key={i} cx={x(pc[0].tMs)} cy={y(pc[0].elevationDeg)} r={1.6} fill="#e8c547" />)}
      {unknown.map((p, i) => <circle key={`u${i}`} cx={x(p.tMs)} cy={y(p.elevationDeg)} r={2.2} fill="none" stroke="#d9534f" data-unknown="true" />)}
      {selectedMs >= startMs && selectedMs <= endMs && <line x1={x(selectedMs)} x2={x(selectedMs)} y1={2} y2={H - padB} stroke="#8fd3ff" strokeWidth={1} />}
      <text x={padL} y={H - 3} fontSize={6} fill="#aaa">{utcShort(startMs)}</text>
      <text x={W} y={H - 3} fontSize={6} fill="#aaa" textAnchor="end">{utcShort(endMs)} UTC</text>
    </svg>
  )
}
