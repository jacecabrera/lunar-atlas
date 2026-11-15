import Scene from './scene/Scene'
import Timeline from './ui/Timeline'
import Sidebar from './ui/Sidebar'
import Results from './ui/Results'
import HoverReadout from './ui/HoverReadout'
import { useEffect } from 'react'
import { useApp, SIDEBAR_WIDTH } from './state/appStore'
import { startClockDriver } from './time/clockDriver'

export default function App() {
  const { focus, toggleFocus, sceneIssues, sidebarOpen } = useApp()
  const right = sidebarOpen ? SIDEBAR_WIDTH : 0
  useEffect(() => startClockDriver(), []) // the single clock loop (reference-counted for StrictMode)
  return (
    <>
      {/* The canvas fills the area left of the sidebar; R3F follows the container size. */}
      <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, right }}><Scene /></div>
      <button style={{ position: 'fixed', top: 56, left: 12 }} onClick={toggleFocus}>
        Focus: {focus}
      </button>
      {sceneIssues.length > 0 && (
        <div role="alert" style={{ position: 'fixed', top: 90, left: 12, maxWidth: 360, padding: '6px 10px', color: '#ffd27a', background: 'rgba(0,0,0,0.7)', font: '12px system-ui, sans-serif' }}>
          {sceneIssues.map((m) => <div key={m}>{m}</div>)}
        </div>
      )}
      <Timeline right={right} />
      <Sidebar><Results /></Sidebar>
      <HoverReadout right={right} />
    </>
  )
}