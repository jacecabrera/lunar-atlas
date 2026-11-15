import Scene from './scene/Scene'
import Timeline from './ui/Timeline'
import Sidebar from './ui/Sidebar'
import Results from './ui/Results'
import HoverReadout from './ui/HoverReadout'
import RoutePanel from './ui/RoutePanel'
import { useEffect } from 'react'
import { useApp, SIDEBAR_WIDTH } from './state/appStore'
import { startClockDriver } from './time/clockDriver'

export default function App() {
  const { focus, toggleFocus, exaggerate, toggleExaggerate, sceneIssues, sidebarOpen } = useApp()
  const right = sidebarOpen ? SIDEBAR_WIDTH : 0
  useEffect(() => startClockDriver(), []) // the single clock loop (reference-counted for StrictMode)
  return (
    <>
      {/* The canvas fills the area left of the sidebar; R3F follows the container size. */}
      <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, right }}><Scene /></div>
      <div className="vignette" aria-hidden="true" />
      <div style={{ position: 'fixed', top: 56, left: 12, display: 'flex', gap: 8 }}>
        <span className="seg">
          <button className={`seg-btn${focus === 'earth' ? ' on' : ''}`} onClick={toggleFocus}>Earth</button>
          <button className={`seg-btn${focus === 'moon' ? ' on' : ''}`} onClick={toggleFocus}>Moon</button>
        </span>
        <span className="seg">
          <button className={`seg-btn${!exaggerate ? ' on' : ''}`} onClick={toggleExaggerate} aria-pressed={!exaggerate} title="Display only: true scale; positions and calculations stay true">True scale</button>
          <button className={`seg-btn${exaggerate ? ' on' : ''}`} onClick={toggleExaggerate} aria-pressed={exaggerate} title="Display only: draws the Earth and Moon 10 times larger; positions and calculations stay true">×10</button>
        </span>
      </div>
      {sceneIssues.length > 0 && (
        <div role="alert" className="issue-banner" style={{ position: 'fixed', top: 56, left: 270, maxWidth: 360, padding: '6px 10px', color: 'var(--warn)', fontSize: 12 }}>
          {sceneIssues.map((m) => <div key={m}>{m}</div>)}
        </div>
      )}
      <RoutePanel />
      <Timeline right={right} />
      <Sidebar><Results /></Sidebar>
      <HoverReadout right={right} />
    </>
  )
}