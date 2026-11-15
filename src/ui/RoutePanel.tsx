import { useState } from 'react'
import { useRoutes } from '../state/routesStore'
import { useCustomSites } from '../state/customSites'
import { useRouteModel } from '../scene/useRouteModel'
import { DEMO_LABEL, ILLUSTRATIVE_LABEL, draftMarker, drawableRoutes, formatUtc, showDemo } from '../scene/routeModel'

// Route legend and controls (step 20). Lists exactly the routes the scene draws, with endpoint times, and says why a
// valid point has no route. The demo route has its own show / hide control; it is hidden while real routes are drawn.
const swatch = (color: string, shape: 'disc' | 'ring' | 'diamond' = 'disc'): React.CSSProperties => ({
  display: 'inline-block', width: 9, height: 9, marginRight: 7, verticalAlign: 'middle',
  background: shape === 'ring' ? 'transparent' : color, border: shape === 'ring' ? `2px solid ${color}` : 'none',
  borderRadius: shape === 'diamond' ? 0 : '50%', transform: shape === 'diamond' ? 'rotate(45deg) scale(0.85)' : undefined,
  boxShadow: shape === 'diamond' ? '0 0 4px rgba(143,168,200,0.5)' : undefined,
})

export default function RoutePanel() {
  const model = useRouteModel()
  const demoEnabled = useRoutes((s) => s.demoEnabled)
  const setDemoEnabled = useRoutes((s) => s.setDemoEnabled)
  const requestView = useRoutes((s) => s.requestView)
  const editor = useCustomSites((s) => s.editor)
  const [open, setOpen] = useState(true)
  const drawable = drawableRoutes(model)
  const demoShown = showDemo(model, demoEnabled)
  const unavailable = model.routes.filter((r) => r.status === 'unavailable')
  const draft = draftMarker(editor)
  return (
    <section aria-label="Routes" data-testid="route-panel" className="glass routes-panel" style={{ position: 'fixed', top: 96, left: 12, maxWidth: 330, maxHeight: '45vh', overflowY: 'auto', padding: '8px 12px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong className="upper-label" style={{ flex: 1 }}>Routes</strong>
        <button className="hud-btn" onClick={requestView} disabled={drawable.length === 0 && !demoShown} title="Frame the Earth, the Moon and the route once; you can orbit freely afterwards">View route</button>
        <button className="hud-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide list' : 'Show list'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          {drawable.map((r) => (
            <div key={r.id} data-testid="route-item" className="route-row">
              <span style={swatch(r.colour)} /><strong>{r.name}</strong> <span style={{ opacity: 0.7 }}>[{r.siteId}]</span> — {ILLUSTRATIVE_LABEL}<br />
              <span style={{ opacity: 0.85 }}>Earth endpoint {formatUtc(r.launchTimeMs)}<br />Moon endpoint {formatUtc(r.landingTimeMs)}</span>
              {r.notes.map((n) => <div key={n} style={{ opacity: 0.75 }}>{n}</div>)}
            </div>
          ))}
          {unavailable.map((r) => r.status === 'unavailable' && (
            <div key={r.id} data-testid="route-unavailable" className="route-row" style={{ color: 'var(--warn)' }}>
              <span style={swatch(r.colour)} /><strong>{r.name}</strong>: no route. {r.reason}
            </div>
          ))}
          {drawable.length === 0 && unavailable.length === 0 && <div style={{ opacity: 0.8, color: 'var(--dim)' }}>No valid route to draw.</div>}
          <label style={{ display: 'block', marginTop: 4 }}>
            <input className="check" type="checkbox" checked={demoEnabled} onChange={(e) => setDemoEnabled(e.target.checked)} /> Demo route
            {drawable.length > 0 && <span style={{ opacity: 0.7 }}> (hidden while real routes are shown)</span>}
          </label>
          {demoShown && <div data-testid="demo-note"><span className="swatch sw-diamond" />{DEMO_LABEL}. Not a candidate, a recommendation or a flight plan; no dates, flight time or score.</div>}
          <div style={{ marginTop: 6, opacity: 0.85, fontSize: 11 }}>
            <div><span className="swatch sw-disc" />Filled disc: valid recommendation / confirmed custom site</div>
            <div><span className="swatch sw-ring" />Ring: unconfirmed draft point{draft ? ` (“${draft.name}”, not counted)` : ''}</div>
            <div><span className="swatch sw-diamond" />Diamond: demo route endpoints</div>
          </div>
        </div>
      )}
    </section>
  )
}
