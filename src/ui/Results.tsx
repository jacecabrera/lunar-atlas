import { useState } from 'react'
import { useMission } from '../state/missionStore'
import { useCustomSites, MAX_CUSTOM_SITES } from '../state/customSites'
import { confirmCheck, siteStateLabel, isValidCustom, currentAssessment } from '../state/customSitesModel'
import type { CustomSite } from '../state/customSitesModel'
import { loadCandidateCatalog } from '../sim'
import { decisionSummary } from '../sim'
import type { TaskState, SummaryReason, SiteAssessment } from '../sim'
import { NumberField } from './fields'
import { useDetailsLaunch } from '../snapshots/launcher'
import { snapshotBlockedReason } from '../snapshots/build'

// Recommendations and custom sites (step 19). The list shows exactly what the current task returned (0-3, existing
// order, no re-ranking, no padding). Custom sites use the same rules through the scheduler; clicking the Moon only fills
// the editor. Unknown, service errors and proven failures are always worded differently, never only by colour.

const catalog = loadCandidateCatalog()
const nameOf = (id: string) => catalog.candidates.find((c) => c.id === id)?.name ?? id
const coordOf = (id: string) => catalog.candidates.find((c) => c.id === id)?.coordinate
const fmt = (v: number, d = 4) => v.toFixed(d)
const h2: React.CSSProperties = { margin: '16px 0 8px' }
const dotClass = { neutral: 'dot-idle', busy: 'dot-busy', ok: 'dot-ok', fail: 'dot-err', unknown: 'dot-warn', error: 'dot-err' } as const

/** Proven failures first, then service errors, then missing data, so a failure is never cut off by a long list. */
function reasonKinds(reasons: SummaryReason[]) {
  const rank = { fail: 0, error: 1, unknown: 2 } as const
  return [...reasons].sort((a, b) => rank[a.status] - rank[b.status]).map((r) => `${r.status === 'fail' ? 'Shown not to meet' : r.status === 'error' ? 'Service error' : 'Not enough data'} (${r.condition}): ${r.message}`)
}

/** What a regional estimate assumes, and the risks it did not evaluate; shown whenever an estimated point is listed. */
function EstimateNotes({ a }: { a: SiteAssessment | undefined }) {
  const d = a?.decision
  if (!d || !d.estimated) return null
  const scale = d.scale
  return (
    <details style={{ marginTop: 4 }} data-testid="estimate-notes">
      <summary style={{ cursor: 'pointer', fontSize: 11 }}>Estimated, not evidence: scale, assumptions and risks</summary>
      <div style={{ fontSize: 11 }}>
        {scale && <p style={{ margin: '2px 0' }}>Scale: slope over {scale.slopeBaselineKm?.toFixed(1) ?? '?'} km of a {scale.slopePostingKm?.toFixed(2) ?? '?'} km product; skyline every {scale.horizonAzimuthStepDeg ?? '?'}° to {scale.horizonRangeKm ?? '?'} km; {scale.timeResolution}.</p>}
        <div style={{ fontWeight: 600 }}>Risks not evaluated</div>
        <ul style={{ margin: '2px 0', paddingLeft: 16 }}>{d.risks.map((x, i) => <li key={i}>{x}</li>)}</ul>
        <div style={{ fontWeight: 600 }}>Assumptions</div>
        <ul style={{ margin: '2px 0', paddingLeft: 16 }}>{d.assumptions.map((x, i) => <li key={i}>{x}</li>)}</ul>
        {d.warnings.length > 0 && <><div style={{ fontWeight: 600 }}>Data quality warnings accepted by the estimate</div><ul style={{ margin: '2px 0', paddingLeft: 16 }}>{d.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      </div>
    </details>
  )
}

/** Whole-Moon search report: the best of the evaluated points, with coverage, and a partial or unavailable search stated as such. */
function SearchReport() {
  const task = useMission((s) => s.task)
  if (task.status !== 'done' && task.status !== 'stale') return null
  const s = task.result.search
  if (!s) return null
  const c = s.coverage
  return (
    <section aria-label="Whole-Moon search" data-testid="search-report" style={{ marginTop: 10, opacity: task.status === 'stale' ? 0.6 : 1 }}>
      <h2 className="upper-label" style={h2}>Best among evaluated sites <span style={{ fontWeight: 400, fontSize: 12 }}>(whole-Moon search, {s.status})</span></h2>
      <div className="site-card"><p style={{ fontSize: 12, margin: 0 }}>{s.message}</p></div>
      {s.results.length === 0
        ? <div className="site-card"><p style={{ fontSize: 12, margin: 0 }}>{s.status === 'unavailable' ? 'No search was run.' : 'No evaluated point qualifies in this search.'}</p></div>
        : (
          <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {s.results.map((x, i) => (
              <li key={x.siteId} className="site-card">
                <strong>{i + 1}. {x.name}</strong> <span style={{ fontSize: 11, opacity: 0.7 }}>[{x.siteId}] search result, estimated</span><br />
                <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(x.lat, 2)}°, {fmt(x.lon, 2)}°</span> <span style={{ fontSize: 12 }}>score {x.score.toFixed(2)} (ranking aid, not a success probability)</span>
                <EstimateNotes a={x.assessment} />
              </li>
            ))}
          </ol>
        )}
      <details className="site-card">
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>Search coverage</summary>
        <ul style={{ fontSize: 11, margin: '2px 0', paddingLeft: 16 }} data-testid="search-coverage">
          <li>Coarse grid: {c.coarsePoints} points ({s.config.coarseStepDeg}° spacing); proven excluded by the same rules as a full evaluation: {c.provenExcluded.regionalSlope} (regional slope), {c.provenExcluded.noEarthPossible} (Earth never rises), {c.provenExcluded.noTerrainData} (no terrain data)</li>
          <li>Screened in and queued by geometric priority (a heuristic order, not a verdict): {c.screenedIn}</li>
          <li>Fully evaluated: {c.fullyEvaluated} ({c.qualifying} qualify, {c.notQualifying.fail} shown not to qualify, {c.notQualifying.unknown} not enough data, {c.notQualifying.error + c.failed} errors)</li>
          <li>Not evaluated (cap or time; not called unqualified): {c.notEvaluated}</li>
          <li>Refinement ({s.config.refineStepDeg}° spacing around {c.refinement.seeds.length} region(s), ±{c.refinement.halfWidthDeg}°): {c.refinement.evaluated} of {c.refinement.points} points evaluated</li>
          <li>Stopped because: {s.reason}; {Math.round(s.elapsedMs / 100) / 10} s{s.terrain ? `; global terrain: ${s.terrain.tilesLoaded} tile(s) fetched this run, ${(s.terrain.compressedBytes / 1e6).toFixed(1)} MB (cached for later searches in this session)` : ''}</li>
        </ul>
      </details>
    </section>
  )
}

function Recommendations() {
  const task = useMission((s) => s.task)
  if (task.status !== 'done' && task.status !== 'stale') return null
  const r = task.result
  const stale = task.status === 'stale'
  const estimated = r.mode === 'relaxed'
  const ex = r.evaluation?.excluded
  return (
    <section aria-label="Recommendations" style={{ opacity: stale ? 0.6 : 1 }}>
      <h2 className="upper-label" style={h2}>{estimated ? 'Recommended sites (regional estimate)' : 'Recommended sites'} {stale && <span style={{ fontWeight: 400, fontSize: 12 }}>(out of date: inputs changed)</span>}</h2>
      {r.recommendations.length === 0 ? <div className="site-card"><p style={{ fontSize: 12, margin: 0 }}>{estimated ? 'No catalogue site qualifies in the regional estimate for these inputs.' : 'No eligible recommendation for these inputs.'} This is a normal result, not a failure of the calculation.</p></div> : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {r.recommendations.map((x, i) => { const c = coordOf(x.siteId); return (
            <li key={x.siteId} className="site-card">
              <strong>{i + 1}. {nameOf(x.siteId)}</strong> <span style={{ fontSize: 11, opacity: 0.7 }}>[{x.siteId}]</span><br />
              {c && <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(c.lat)}°, {fmt(c.lon)}°</span>} <span style={{ fontSize: 12 }}>score {x.score.toFixed(2)} (ranking aid, not a success probability)</span>
              {estimated && <div style={{ fontSize: 11, color: '#f2d27a' }} data-testid="estimated-badge">Estimated recommendation: regional scale, not evidence of a safe footprint</div>}
              <EstimateNotes a={r.sites.find((s) => s.siteId === x.siteId)} />
            </li>) })}
        </ol>
      )}
      {ex && (
        <details className="site-card">
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>Why sites were not recommended ({ex.physicalFail.length} shown not to meet a condition, {ex.insufficientData.length} not enough data, {ex.serviceError.length} service errors)</summary>
          {([['Shown not to meet a necessary condition', ex.physicalFail], ['Not enough data to decide', ex.insufficientData], ['Service errors', ex.serviceError]] as const).map(([title, list]) => list.length > 0 && (
            <div key={title} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
              {list.map((x) => (
                <details key={x.siteId} style={{ marginLeft: 8 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12 }}>{nameOf(x.siteId)}</summary>
                  <ul style={{ fontSize: 11, margin: '2px 0 4px', paddingLeft: 16 }}>
                    {(r.sites.find((s) => s.siteId === x.siteId) ? reasonKinds(decisionSummary(r.sites.find((s) => s.siteId === x.siteId)!).reasons) : x.reasons.map((y) => y.message)).slice(0, 12).map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </details>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  )
}

function StateLine({ site, task }: { site: CustomSite; task: TaskState }) {
  const s = siteStateLabel(site, task)
  return <span className="badge"><span className={`dot ${dotClass[s.tone]}`} />State: {s.label}</span>
}

function Editor() {
  const task = useMission((s) => s.task)
  const mode = useMission((s) => s.settings.assessmentMode)
  const { editor, sites, editEditor, check, confirmEditor } = useCustomSites()
  const [message, setMessage] = useState<string[] | null>(null)
  const c = confirmCheck(editor, task, sites.length, MAX_CUSTOM_SITES)
  return (
    <div className="site-card">
      <div className="hint" style={{ marginBottom: 4 }}>New custom site (type coordinates or click the Moon)</div>
      <label className="field-label">Name
        <input value={editor.name} onChange={(e) => editEditor({ name: e.target.value })} aria-label="Custom site name" className="hud-input" style={{ width: '100%' }} />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><NumberField label="Latitude" unit="deg, N+" value={editor.lat} onValue={(v) => editEditor({ lat: v })} showError={editor.lat !== null} error={editor.lat !== null && !(editor.lat >= -90 && editor.lat <= 90) ? 'Latitude must be between -90 and 90' : null} /></div>
        <div style={{ flex: 1 }}><NumberField label="Longitude" unit="deg, E+" value={editor.lon} onValue={(v) => editEditor({ lon: v })} showError={editor.lon !== null} error={editor.lon !== null && !(editor.lon >= -180 && editor.lon <= 180) ? 'Longitude must be between -180 and 180' : null} /></div>
      </div>
      <StateLine site={editor} task={task} />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button className="hud-btn" onClick={() => { const r = check(editor.id); setMessage(r ? [r] : null) }}>Check site</button>
        <button key={String(c.ok)} className={`btn-primary${c.ok ? ' status-flash' : ''}`} disabled={!c.ok} onClick={() => { const r = confirmEditor(); setMessage(r.length ? r : null) }}>Confirm</button>
      </div>
      {!c.ok && <div className="hint" style={{ marginTop: 4 }}>Confirm is disabled: {c.reasons.join('; ')}.</div>}
      {message && <div role="alert" className="error-text">{message.join('; ')}</div>}
      <details className="hud-details" style={{ marginTop: 4 }}>
        <summary>ⓘ About custom site assessment</summary>
        <div className="hint">
          {mode === 'relaxed'
            ? 'Regional estimate: any coordinate is assessed from the 1.9 km global terrain (a point at exactly a catalogue coordinate also keeps that site\'s evidence). The result is an estimate and lists the risks it did not evaluate. Coordinates are not moved or snapped.'
            : 'Evidence-based assessment: terrain packages exist only for the 12 catalogue sites; a point at exactly a catalogue coordinate reuses that terrain, any other point has no footprint or horizon data and stays "not enough data". Coordinates are not moved or snapped.'}
        </div>
      </details>
    </div>
  )
}

function ConfirmedList() {
  const task = useMission((s) => s.task)
  const { sites, renameSite, moveSite, removeSite, check } = useCustomSites()
  if (sites.length === 0) return null
  return (
    <ol style={{ paddingLeft: 0, marginTop: 8, listStyle: 'none' }}>
      {sites.map((s) => {
        const valid = isValidCustom(s, task, sites.length, MAX_CUSTOM_SITES)
        return (
          <li key={s.id} className="site-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <input value={s.name} onChange={(e) => renameSite(s.id, e.target.value)} aria-label={`Name of ${s.id}`} className="hud-input" style={{ flex: 1 }} />
              <span className="hint mono">[{s.id}]</span>
              <span className="badge"><span className={`dot ${valid ? 'dot-ok' : 'dot-warn'}`} />{valid ? 'VALID' : 'CHECK AGAIN'}</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}><NumberField label="Latitude" value={s.lat} onValue={(v) => moveSite(s.id, v, s.lon)} showError={false} /></div>
              <div style={{ flex: 1 }}><NumberField label="Longitude" value={s.lon} onValue={(v) => moveSite(s.id, s.lat, v)} showError={false} /></div>
            </div>
            <StateLine site={s} task={task} />
            <EstimateNotes a={currentAssessment(s, task) ?? undefined} />
            <div className="hint" style={{ marginTop: 2 }}>{valid ? 'Valid for the current mission' : 'Not valid for the current mission (check again after changes)'}</div>
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
              <button className="hud-btn" onClick={() => check(s.id)}>Check again</button>
              <button className="hud-btn" onClick={() => removeSite(s.id)}>Delete</button>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Learn more: opens the details page in a new tab with an independent snapshot of the current results (step 21). */
function LearnMore() {
  const task = useMission((s) => s.task)
  const { state, click } = useDetailsLaunch()
  const blocked = snapshotBlockedReason(task)
  return (
    <section aria-label="Details" style={{ marginTop: 12 }}>
      <button className="hud-btn" onClick={click} disabled={blocked !== null || state.phase === 'saving'} title={blocked ?? 'Open the details page in a new tab'}>Learn more</button>
      <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }} data-testid="learn-more-status">
        {blocked ?? (state.phase === 'saving' ? 'Saving the details snapshot…'
          : state.phase === 'done' ? (state.outcome.opened ? 'Details opened in a new tab. It keeps showing this result even if you change or clear the inputs here.' : '')
          : state.phase === 'failed' ? '' : 'Opens the details of these results in a new tab (a saved copy, stored in this browser only).')}
      </div>
      {state.phase === 'done' && !state.outcome.opened && (
        <div role="alert" style={{ fontSize: 12, color: '#f2d27a' }}>The browser blocked the new tab. The details are saved: <a href={state.outcome.url} target="_blank" rel="noopener noreferrer">open them here</a>.</div>
      )}
      {state.phase === 'failed' && (
        <div role="alert" style={{ fontSize: 12, color: '#ffb4a8' }}>
          Could not save the details: {state.error}. <button onClick={click}>Retry</button>
          {!state.opened && <span> (no tab was opened)</span>}
        </div>
      )}
    </section>
  )
}

export default function Results() {
  const sites = useCustomSites((s) => s.sites)
  return (
    <>
      <Recommendations />
      <SearchReport />
      <section aria-label="Custom sites">
        <h2 className="upper-label" style={h2}>Custom sites ({sites.length} of {MAX_CUSTOM_SITES})</h2>
        <Editor />
        <ConfirmedList />
      </section>
      <LearnMore />
    </>
  )
}
