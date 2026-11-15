import { useState } from 'react'
import { useMission } from '../state/missionStore'
import { useCustomSites, MAX_CUSTOM_SITES } from '../state/customSites'
import { confirmCheck, siteStateLabel, currentAssessment } from '../state/customSitesModel'
import type { CustomSite } from '../state/customSitesModel'
import { loadCandidateCatalog } from '../sim'
import type { TaskState, SummaryReason } from '../sim'
import { NumberField } from './fields'

// Recommendations and custom sites (step 19). The list shows exactly what the current task returned (0-3, existing
// order, no re-ranking, no padding). Custom sites use the same rules through the scheduler; clicking the Moon only fills
// the editor. Unknown, service errors and proven failures are always worded differently, never only by colour.

const catalog = loadCandidateCatalog()
const nameOf = (id: string) => catalog.candidates.find((c) => c.id === id)?.name ?? id
const coordOf = (id: string) => catalog.candidates.find((c) => c.id === id)?.coordinate
const fmt = (v: number, d = 4) => v.toFixed(d)
const h2: React.CSSProperties = { fontSize: 14, margin: '16px 0 6px' }
const toneColor = { neutral: '#bbb', busy: '#9cc9ff', ok: '#8fe39a', fail: '#ff8a7a', unknown: '#f2d27a', error: '#ff8a7a' } as const

/** Proven failures first, then service errors, then missing data, so a failure is never cut off by a long list. */
function reasonKinds(reasons: SummaryReason[]) {
  const rank = { fail: 0, error: 1, unknown: 2 } as const
  return [...reasons].sort((a, b) => rank[a.status] - rank[b.status]).map((r) => `${r.status === 'fail' ? 'Shown not to meet' : r.status === 'error' ? 'Service error' : 'Not enough data'} (${r.condition}): ${r.message}`)
}

function Recommendations() {
  const task = useMission((s) => s.task)
  if (task.status !== 'done' && task.status !== 'stale') return null
  const r = task.result
  const stale = task.status === 'stale'
  const ex = r.evaluation?.excluded
  return (
    <section aria-label="Recommendations" style={{ opacity: stale ? 0.6 : 1 }}>
      <h2 style={h2}>Recommended sites {stale && <span style={{ fontWeight: 400, fontSize: 12 }}>(out of date: inputs changed)</span>}</h2>
      {r.recommendations.length === 0 ? <p style={{ fontSize: 12 }}>No eligible recommendation for these inputs. This is a normal result, not a failure of the calculation.</p> : (
        <ol style={{ paddingLeft: 18, margin: 0 }}>
          {r.recommendations.map((x) => { const c = coordOf(x.siteId); return (
            <li key={x.siteId} style={{ marginBottom: 4 }}>
              <strong>{nameOf(x.siteId)}</strong> <span style={{ fontSize: 11, opacity: 0.7 }}>[{x.siteId}]</span><br />
              {c && <span style={{ fontFamily: 'ui-monospace, monospace' }}>{fmt(c.lat)}°, {fmt(c.lon)}°</span>} <span style={{ fontSize: 12 }}>score {x.score.toFixed(2)} (ranking aid, not a success probability)</span>
            </li>) })}
        </ol>
      )}
      {ex && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>Why sites were not recommended ({ex.physicalFail.length} shown not to meet a condition, {ex.insufficientData.length} not enough data, {ex.serviceError.length} service errors)</summary>
          {([['Shown not to meet a necessary condition', ex.physicalFail], ['Not enough data to decide', ex.insufficientData], ['Service errors', ex.serviceError]] as const).map(([title, list]) => list.length > 0 && (
            <div key={title} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
              {list.map((x) => (
                <details key={x.siteId} style={{ marginLeft: 8 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12 }}>{nameOf(x.siteId)}</summary>
                  <ul style={{ fontSize: 11, margin: '2px 0 4px', paddingLeft: 16 }}>
                    {(r.sites.find((s) => s.siteId === x.siteId)?.summary.reasons ? reasonKinds(r.sites.find((s) => s.siteId === x.siteId)!.summary.reasons) : x.reasons.map((y) => y.message)).slice(0, 12).map((t, i) => <li key={i}>{t}</li>)}
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
  return <div style={{ fontSize: 12, color: toneColor[s.tone] }}>State: {s.label}</div>
}

function Editor() {
  const task = useMission((s) => s.task)
  const { editor, sites, editEditor, check, confirmEditor } = useCustomSites()
  const [message, setMessage] = useState<string[] | null>(null)
  const c = confirmCheck(editor, task, sites.length, MAX_CUSTOM_SITES)
  return (
    <div style={{ border: '1px solid #444', padding: 8, borderRadius: 4 }}>
      <div style={{ fontSize: 12, marginBottom: 4 }}>New custom site (type coordinates or click the Moon)</div>
      <label style={{ display: 'block', fontSize: 12 }}>Name
        <input value={editor.name} onChange={(e) => editEditor({ name: e.target.value })} aria-label="Custom site name" style={{ width: '100%', boxSizing: 'border-box' }} />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><NumberField label="Latitude" unit="deg, N+" value={editor.lat} onValue={(v) => editEditor({ lat: v })} showError={editor.lat !== null} error={editor.lat !== null && !(editor.lat >= -90 && editor.lat <= 90) ? 'Latitude must be between -90 and 90' : null} /></div>
        <div style={{ flex: 1 }}><NumberField label="Longitude" unit="deg, E+" value={editor.lon} onValue={(v) => editEditor({ lon: v })} showError={editor.lon !== null} error={editor.lon !== null && !(editor.lon >= -180 && editor.lon <= 180) ? 'Longitude must be between -180 and 180' : null} /></div>
      </div>
      <StateLine site={editor} task={task} />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button onClick={() => { const r = check(editor.id); setMessage(r ? [r] : null) }}>Check site</button>
        <button disabled={!c.ok} onClick={() => { const r = confirmEditor(); setMessage(r.length ? r : null) }}>Confirm</button>
      </div>
      {!c.ok && <div style={{ fontSize: 11, marginTop: 4 }}>Confirm is disabled: {c.reasons.join('; ')}.</div>}
      {message && <div role="alert" style={{ fontSize: 12, color: '#ffb4a8' }}>{message.join('; ')}</div>}
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>Terrain packages exist only for the 12 catalogue sites; other points have no footprint or horizon data and stay "not enough data". Coordinates are not moved or snapped.</div>
    </div>
  )
}

function ConfirmedList() {
  const task = useMission((s) => s.task)
  const { sites, renameSite, moveSite, removeSite, check } = useCustomSites()
  if (sites.length === 0) return null
  return (
    <ol style={{ paddingLeft: 18, marginTop: 8 }}>
      {sites.map((s) => {
        const valid = !!currentAssessment(s, task)?.summary.eligibleForRecommendation && confirmCheck(s, task, sites.length, MAX_CUSTOM_SITES, true).ok
        return (
          <li key={s.id} style={{ marginBottom: 8 }}>
            <input value={s.name} onChange={(e) => renameSite(s.id, e.target.value)} aria-label={`Name of ${s.id}`} style={{ width: '70%' }} />
            <span style={{ fontSize: 11, opacity: 0.7 }}> [{s.id}]</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}><NumberField label="Latitude" value={s.lat} onValue={(v) => moveSite(s.id, v, s.lon)} showError={false} /></div>
              <div style={{ flex: 1 }}><NumberField label="Longitude" value={s.lon} onValue={(v) => moveSite(s.id, s.lat, v)} showError={false} /></div>
            </div>
            <StateLine site={s} task={task} />
            <div style={{ fontSize: 12 }}>{valid ? 'Valid for the current mission' : 'Not valid for the current mission (check again after changes)'}</div>
            <button onClick={() => check(s.id)}>Check again</button> <button onClick={() => removeSite(s.id)}>Delete</button>
          </li>
        )
      })}
    </ol>
  )
}

export default function Results() {
  const sites = useCustomSites((s) => s.sites)
  return (
    <>
      <Recommendations />
      <section aria-label="Custom sites">
        <h2 style={h2}>Custom sites ({sites.length} of {MAX_CUSTOM_SITES})</h2>
        <Editor />
        <ConfirmedList />
      </section>
    </>
  )
}
