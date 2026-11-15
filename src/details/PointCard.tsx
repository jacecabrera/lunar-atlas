import type { DetailSnapshot, SnapshotPoint } from '../sim/snapshot'
import { metricRows, timelineSegments, unknownDurationMs, completenessNote, curvePoints } from './metrics'
import type { MetricRow } from './metrics'
import { TimelineStrip, ElevationCurve } from './charts'
import { Explain } from './ExplainPanel'
import { describeNext, nextKey, NEXT_TARGETS } from './nextEventModel'
import type { NextTarget, Reproducible } from './nextEventModel'
import type { NextState } from './nextState'
import { duration, utc } from './format'

// One point's column on the details page (step 22): everything comes from the snapshot. Values that are not determined are
// N/A with their reason (never 0), unknown time is its own state in the timelines, and each core number has an Explain button.
const tone = { found: '#8fe39a', 'not-found': '#bbb', unknown: '#f2d27a', incomplete: '#f2d27a' } as const

function Row({ r, snap, p }: { r: MetricRow; snap: DetailSnapshot; p: SnapshotPoint }) {
  return (
    <div role="row" data-metric={r.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, padding: '2px 0', borderBottom: '1px solid #222' }}>
      <span style={{ flex: '1 1 150px', fontSize: 12 }}>{r.label}</span>
      {r.value.ok
        ? <strong data-testid={`value-${r.key}`}>{r.value.text}</strong>
        : <span data-testid={`value-${r.key}`} title={r.value.reason}><strong style={{ color: '#f2d27a' }}>N/A</strong> <span style={{ fontSize: 11, opacity: 0.85 }}>{r.value.reason}</span></span>}
      <Explain k={r.key} snap={snap} point={p} />
    </div>
  )
}

function NextRow({ target, p, snap, state, repro }: { target: NextTarget; p: SnapshotPoint; snap: DetailSnapshot; state: NextState; repro: Reproducible }) {
  const label = target === 'sunset' ? 'Next sunset' : 'Next Earthset'
  const e = state[nextKey(p.id, target)]
  let body: React.ReactNode
  if (!repro.ok) body = <span style={{ color: '#f2d27a' }}>Unavailable (model differs from this snapshot)</span>
  else if (!e || e.status === 'running') body = <span role="status">Calculating…</span>
  else if (e.status === 'error') body = <span style={{ color: '#ffb4a8' }}>Query failed: {e.message}</span>
  else {
    const d = describeNext(e.result, target)
    body = <span data-state={d.state}><strong style={{ color: tone[d.state] }}>{d.headline}</strong>{e.result.status === 'found' && <span> — in {duration(e.result.msUntil!)}</span>}<div style={{ fontSize: 11, opacity: 0.85 }}>{d.detail}</div></span>
  }
  return (
    <div role="row" data-next={target} style={{ padding: '3px 0', borderBottom: '1px solid #222' }}>
      <span style={{ fontSize: 12 }}>{label}</span> {body} <Explain k={target === 'sunset' ? 'nextSunset' : 'nextEarthset'} snap={snap} point={p} />
    </div>
  )
}

/** The estimate's mode, scale, risks and assumptions (frozen in the snapshot). */
function EstimateBlock({ p }: { p: SnapshotPoint }) {
  const d = p.assessment.decision!
  return (
    <div data-testid="estimate-block" style={{ fontSize: 12, padding: 6, borderRadius: 4, background: '#2b2410', margin: '4px 0' }}>
      <strong style={{ color: '#f2d27a' }}>Regional estimate, not evidence.</strong> {d.source === 'search' ? 'A search result on a global grid; ' : ''}
      {d.scale && <>slope over {d.scale.slopeBaselineKm?.toFixed(1) ?? '?'} km of a {d.scale.slopePostingKm?.toFixed(2) ?? '?'} km product, skyline every {d.scale.horizonAzimuthStepDeg ?? '?'}° to {d.scale.horizonRangeKm ?? '?'} km, {d.scale.timeResolution}.</>}
      <details style={{ marginTop: 2 }}>
        <summary style={{ cursor: 'pointer' }}>Risks not evaluated and assumptions</summary>
        <div style={{ fontWeight: 600 }}>Risks not evaluated</div>
        <ul style={{ margin: '2px 0', paddingLeft: 16 }}>{d.risks.map((x, i) => <li key={i}>{x}</li>)}</ul>
        <div style={{ fontWeight: 600 }}>Assumptions</div>
        <ul style={{ margin: '2px 0', paddingLeft: 16 }}>{d.assumptions.map((x, i) => <li key={i}>{x}</li>)}</ul>
        {d.warnings.length > 0 && <><div style={{ fontWeight: 600 }}>Data quality warnings accepted</div><ul style={{ margin: '2px 0', paddingLeft: 16 }}>{d.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
        <div style={{ opacity: 0.8 }}>Data: {d.dataUsed.join('; ')}</div>
      </details>
    </div>
  )
}

export default function PointCard({ p, snap, color, selectedMs, state, repro, onHide, onClose }: {
  p: SnapshotPoint; snap: DetailSnapshot; color: string; selectedMs: number; state: NextState; repro: Reproducible; onHide: () => void; onClose: () => void
}) {
  const s = p.data.statistics
  const rows = metricRows(s)
  const note = completenessNote(s)
  const sun = timelineSegments(s, 'sun'), earth = timelineSegments(s, 'earth')
  const groups = ['Sun', 'Earth', 'Sun and Earth'] as const
  return (
    <article aria-label={p.name} data-testid="point-card" data-point={p.id} style={{ border: `2px solid ${color}`, borderRadius: 6, padding: 10, background: '#0d1016', minWidth: 0 }}>
      <header style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <h2 style={{ fontSize: 15, margin: 0, flex: 1, color }}>{p.name}</h2>
        <button className="hud-btn" onClick={onHide} style={{ fontSize: 11 }}>Hide</button>
        <button className="hud-btn" onClick={onClose} aria-label={`Close ${p.name}`} style={{ fontSize: 11 }}>Close</button>
      </header>
      <div style={{ fontSize: 11, opacity: 0.8, margin: '2px 0 6px' }}>
        [{p.id}] {p.kind === 'recommendation' ? `Recommendation ${p.rank}, score ${p.score!.toFixed(2)} (a ranking aid, not a probability)` : p.kind === 'search' ? `Whole-Moon search result ${p.rank}, score ${p.score!.toFixed(2)} (best among evaluated sites)` : 'Confirmed custom site'} · {p.lat.toFixed(4)}°, {p.lon.toFixed(4)}°
      </div>
      {p.assessment.decision?.estimated && <EstimateBlock p={p} />}
      <div style={{ fontSize: 12, padding: 6, borderRadius: 4, background: note.level === 'incomplete' ? '#3a2d12' : '#141b26', margin: '4px 0' }} data-testid="completeness" data-level={note.level}>{note.text}</div>
      <div role="table" aria-label={`Metrics of ${p.name}`}>
        {groups.map((g) => (
          <section key={g} aria-label={g}>
            <h3 style={{ fontSize: 12, margin: '8px 0 2px', opacity: 0.8 }}>{g}</h3>
            {rows.filter((r) => r.group === g).map((r) => <Row key={r.key} r={r} snap={snap} p={p} />)}
          </section>
        ))}
      </div>
      <h3 style={{ fontSize: 12, margin: '10px 0 0', opacity: 0.8 }}>Timeline (UTC) <Explain k="timeline" snap={snap} point={p} /></h3>
      <TimelineStrip label="Sun" visibleName="sunlit" segments={sun} startMs={s.window.startMs} endMs={s.window.endMs} selectedMs={selectedMs} />
      <TimelineStrip label="Earth" visibleName="Earth visible" segments={earth} startMs={s.window.startMs} endMs={s.window.endMs} selectedMs={selectedMs} />
      <div style={{ fontSize: 11, opacity: 0.85 }}>Yellow: visible. Dark: not visible. Red hatching: unknown{unknownDurationMs(sun) + unknownDurationMs(earth) > 0 ? ` (Sun ${duration(unknownDurationMs(sun))}, Earth ${duration(unknownDurationMs(earth))})` : ' (none in this window)'}. The light-blue line is the selected time.</div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>Sun elevation curve</summary>
        <ElevationCurve points={curvePoints(p)} startMs={s.window.startMs} endMs={s.window.endMs} selectedMs={selectedMs} />
        <div style={{ fontSize: 11 }}>Sun centre elevation at fixed sample times; negative values are below the horizontal plane. <Explain k="curve" snap={snap} point={p} /></div>
      </details>
      <h3 style={{ fontSize: 12, margin: '10px 0 2px', opacity: 0.8 }}>At the selected time {utc(selectedMs)}</h3>
      <div role="table" aria-label={`Next events of ${p.name}`}>{NEXT_TARGETS.map((t) => <NextRow key={t} target={t} p={p} snap={snap} state={state} repro={repro} />)}</div>
    </article>
  )
}
