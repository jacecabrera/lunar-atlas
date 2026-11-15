import { useMemo, useState } from 'react'
import { useSnapshot, snapshotIdFromLocation } from './useSnapshot'
import type { DetailSnapshot } from '../sim/snapshot'
import PointCard from './PointCard'
import { useNextEvents } from './useNextEvents'
import { settingRows, summaryLines } from './settingsSummary'
import { utc } from './format'
import { parseUtcInput, formatUtc } from '../time/clock'
import { RefLine } from './ExplainPanel'
import { MOON_TEXTURE_REF } from './explain'
import { explain } from './explain'
import type { ExplainRef } from './explain'

// Details page (steps 21-22). It shows one saved snapshot and nothing else: no store, no task, no 3D scene, no clock. Hiding or
// closing a point only changes this page's view; the snapshot is never modified. Side-by-side comparison only: there is no
// baseline and no "change from baseline".
const box: React.CSSProperties = { maxWidth: 1500, margin: '0 auto', padding: 20, color: '#ddd', font: '14px var(--font-ui)', lineHeight: 1.5 }
const PALETTE = ['#4cc9f0', '#f9c74f', '#90be6d', '#f8961e', '#b39ddb', '#f94144', '#43aa8b', '#ff9f1c', '#2ec4b6', '#e9c46a', '#a8dadc', '#e56b6f']

export function Loaded({ s }: { s: DetailSnapshot }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [selectedMs, setSelectedMs] = useState(s.input.landingTimeMs)
  const [timeText, setTimeText] = useState(formatUtc(s.input.landingTimeMs))
  const [timeError, setTimeError] = useState<string | null>(null)
  const open = s.points.filter((p) => !closed.has(p.id))
  const shown = open.filter((p) => !hidden.has(p.id))
  const { state, repro } = useNextEvents(s, shown, selectedMs)
  const colorOf = (id: string) => PALETTE[s.points.findIndex((p) => p.id === id) % PALETTE.length]
  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n }
  const applyTime = () => {
    const ms = parseUtcInput(timeText)
    if (ms === null) { setTimeError('Enter a UTC time as YYYY-MM-DD HH:MM:SS'); return }
    setTimeError(null); setSelectedMs(ms)
  }
  const refs = useMemo(() => {
    const m = new Map<string, ExplainRef>()
    if (s.points[0]) for (const k of ['sunlitDuration', 'earthWindows', 'sunElevationMean', 'nextSunset'] as const) for (const r of explain(k, s, s.points[0]).refs) if (!m.has(r.id)) m.set(r.id, r)
    m.set(MOON_TEXTURE_REF.id, MOON_TEXTURE_REF)
    for (const src of s.sources) if (!m.has(src.id)) m.set(src.id, { id: src.id, role: src.kind === 'dataset' ? 'dataset' : src.kind === 'model' ? 'model' : src.kind === 'derived' ? 'derived' : src.kind === 'project-assumption' ? 'assumption' : 'source-value', note: src.title })
    return [...m.values()]
  }, [s])

  return (
    <div data-testid="details-loaded">
      <header>
        <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>Mission details</h1>
        <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="settings-summary">{summaryLines(s).map((l) => <li key={l}>{l}</li>)}</ul>
        <details style={{ margin: '6px 0' }}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>All settings of this calculation</summary>
          <table style={{ fontSize: 11, borderCollapse: 'collapse' }}><tbody>{settingRows(s).map((r) => <tr key={r.key}><td style={{ paddingRight: 12 }}><code>{r.key}</code></td><td>{r.value} {r.unit}</td></tr>)}</tbody></table>
        </details>
        <div data-testid="mode-banner" style={{ fontSize: 12, margin: '6px 0', padding: 6, borderRadius: 4, background: s.assessment.mode === 'relaxed' ? '#2b2410' : '#141b26' }}>
          {s.assessment.legacy
            ? <><strong>Evidence-based assessment (legacy snapshot).</strong> Saved before assessment modes existed; it is read under the evidence rules and is not an estimate.</>
            : s.assessment.mode === 'relaxed'
              ? <><strong style={{ color: '#f2d27a' }}>Regional estimate.</strong> Every number below was computed on estimated inputs (regional slope of a global product, nominal skyline); the points are not evidence of a safe footprint. The risks that were not evaluated are listed on each point.</>
              : <><strong>Evidence-based assessment.</strong> Footprint-scale evidence rules and the formal horizon gate.</>}
          {s.assessment.search && <div style={{ marginTop: 4 }} data-testid="search-summary">Whole-Moon search ({s.assessment.search.status}, stopped: {s.assessment.search.reason}): {s.assessment.search.message} {s.assessment.search.coverage.fullyEvaluated} of {s.assessment.search.coverage.coarsePoints} coarse grid points were fully evaluated, {s.assessment.search.coverage.notEvaluated} screened-in points were not evaluated.</div>}
        </div>
        <p style={{ fontSize: 12, opacity: 0.75, margin: '4px 0' }}>Snapshot {s.snapshotId} · saved {utc(s.createdAtMs)} · from calculation {s.task.requestId}. This page shows a saved copy and does not change when the main page changes.</p>
      </header>

      {s.points.length === 0 ? (
        <section data-testid="details-empty" aria-label="No comparable points">
          <h2 style={{ fontSize: 16 }}>No comparable qualifying points</h2>
          <p>No site met every necessary condition for these inputs, so there is nothing to compare. This is a normal result. Why each catalogue site was not recommended:</p>
          <ul>{s.exclusions.map((e) => <li key={e.siteId}><strong>{e.name}</strong> ({e.group.replace(/-/g, ' ')}): {e.reasons.map((r) => r.message).join('; ')}</li>)}</ul>
        </section>
      ) : (
        <>
          <section aria-label="Points" style={{ margin: '10px 0' }}>
            <h2 style={{ fontSize: 14, margin: '0 0 4px' }}>Points ({open.length} of {s.points.length} open)</h2>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {open.map((p) => (
                <li key={p.id} style={{ border: `1px solid ${colorOf(p.id)}`, borderRadius: 4, padding: '2px 8px' }}>
                  <label><input type="checkbox" checked={!hidden.has(p.id)} onChange={() => setHidden(toggle(hidden, p.id))} aria-label={`Show ${p.name}`} /> <span style={{ color: colorOf(p.id) }}>{p.name}</span></label>{' '}
                  <button className="hud-btn" onClick={() => setClosed(toggle(closed, p.id))} aria-label={`Close ${p.name}`} style={{ fontSize: 11, padding: '0 6px' }}>×</button>
                </li>
              ))}
            </ul>
            {closed.size > 0 && <button className="hud-btn" onClick={() => setClosed(new Set())} style={{ marginTop: 4, fontSize: 12 }}>Reopen {closed.size} closed point{closed.size > 1 ? 's' : ''}</button>}
          </section>
          <section aria-label="Selected time" style={{ margin: '10px 0' }}>
            <label>Selected time (UTC) for next sunset and Earthset <input value={timeText} onChange={(e) => setTimeText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyTime() }} aria-label="Selected time UTC" className="hud-input mono" style={{ width: 190 }} /></label>{' '}
            <button className="hud-btn" onClick={applyTime}>Apply</button>{' '}
            <button className="hud-btn" onClick={() => { setTimeText(formatUtc(s.input.landingTimeMs)); setTimeError(null); setSelectedMs(s.input.landingTimeMs) }}>Landing Time</button>
            {timeError && <span role="alert" style={{ color: '#ffb4a8', marginLeft: 8 }}>{timeError}</span>}
            <div style={{ fontSize: 11, opacity: 0.8 }}>Only the next-event lines depend on this time; the mission metrics are fixed. Initial value: the Landing Time.</div>
            {!repro.ok && <div role="alert" data-testid="repro-warning" style={{ color: '#f2d27a', fontSize: 12 }}>{repro.reason}</div>}
          </section>
          {shown.length === 0 ? <p data-testid="none-shown">All points are hidden or closed. Use the checkboxes above{closed.size ? ' or reopen the closed ones' : ''}.</p> : (
            <div data-testid="grid" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', alignItems: 'start' }}>
              {shown.map((p) => <PointCard key={p.id} p={p} snap={s} color={colorOf(p.id)} selectedMs={selectedMs} state={state} repro={repro} onHide={() => setHidden(toggle(hidden, p.id))} onClose={() => setClosed(toggle(closed, p.id))} />)}
            </div>
          )}
        </>
      )}

      <section aria-label="Sources" style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 14 }}>Sources, assumptions and models behind this page</h2>
        <p style={{ fontSize: 12, opacity: 0.8 }}>Entries come from the project's source register. Source values, derived values, project assumptions, models and datasets are labelled differently; sources that were not read in the original are marked unverified. The Moon texture on the main page is display-only.</p>
        <ul style={{ listStyle: 'none', padding: 0 }} data-testid="source-list">{refs.map((r) => <RefLine key={r.id} r={r} />)}</ul>
        <p style={{ fontSize: 11, opacity: 0.7 }}>Model identities: visibility {s.versions.models.visibility}; ephemeris {s.versions.models.ephemeris}.</p>
      </section>
    </div>
  )
}

export default function DetailsApp() {
  const { view, retry } = useSnapshot()
  const id = snapshotIdFromLocation()
  if (view.phase === 'loading') return <div style={box} data-testid="details-loading" role="status">Loading the details… {view.waitedMs > 2000 ? 'Waiting for the main page to finish saving them.' : ''}</div>
  const r = view.result
  if (r.status === 'ok') return <div style={box}><Loaded s={r.snapshot} /></div>
  const text =
    r.status === 'bad-id' ? 'This link has no valid snapshot ID. Open the details from the main page with “Learn more”.'
    : r.status === 'missing' ? (view.saveFailure
      ? `The main page could not save these details: ${view.saveFailure}. Go back to the main page and press “Learn more” again.`
      : 'These details were not found in this browser. They are saved per browser and cannot be opened on another device or profile. If you just pressed “Learn more”, saving may have failed or is still running; you can try again.')
    : r.status === 'corrupt' ? `The saved details are damaged and cannot be shown: ${r.error}.`
    : r.status === 'unsupported-version' ? `${r.error}. These details were saved by a different version of the app.`
    : r.message
  return (
    <div style={box} role="alert" data-testid="details-problem" data-status={r.status}>
      <h1 style={{ fontSize: 20 }}>Details not available</h1>
      <p>{text}</p>
      {(r.status === 'missing' || r.status === 'storage-error') && id && <button className="hud-btn" onClick={retry}>Try again</button>}
    </div>
  )
}
