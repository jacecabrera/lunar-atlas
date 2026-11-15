import Scene from './scene/Scene'
import Timeline from './ui/Timeline'
import { useEffect } from 'react'
import { useApp } from './state/appStore'
import { startClockDriver } from './time/clockDriver'

export default function App() {
  const { exaggerate, toggleExaggerate, focus, toggleFocus } = useApp()
  useEffect(() => startClockDriver(), []) // the single clock loop (reference-counted for StrictMode)
  return (
    <>
      <Scene />
      <button style={{ position: 'fixed', top: 56, left: 12 }} onClick={toggleExaggerate}>
        Sizes: {exaggerate ? 'exaggerated' : 'true scale'}
      </button>
      <button style={{ position: 'fixed', top: 88, left: 12 }} onClick={toggleFocus}>
        Focus: {focus}
      </button>
      <Timeline />
    </>
  )
}