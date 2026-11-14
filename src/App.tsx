import Scene from './scene/Scene'
import Timeline from './ui/Timeline'
import { useApp } from './state/appStore'

export default function App() {
  const { exaggerate, toggleExaggerate, focus, toggleFocus } = useApp()
  return (
    <>
      <Scene />
      <button style={{ position: 'fixed', top: 12, left: 12 }} onClick={toggleExaggerate}>
        Sizes: {exaggerate ? 'exaggerated' : 'true scale'}
      </button>
      <button style={{ position: 'fixed', top: 44, left: 12 }} onClick={toggleFocus}>
        Focus: {focus}
      </button>
      <Timeline />
    </>
  )
}