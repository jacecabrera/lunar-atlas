import { useRef } from 'react'
import type { ComponentRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Vector3 } from 'three'
import { moonPosition } from '../sim'
import { useTime } from '../state/timeStore'
import { useApp, SIZE_EXAGGERATION } from '../state/appStore'
import { useRoutes } from '../state/routesStore'

// True-scale distances from the focused body's centre, scene units (1 unit = 1000 km). Moon radius 1.74, Earth 6.38.
const MOON_VIEW_DIST = 9
const EARTH_VIEW_DIST = 60
// "View route": one jump to a Earth-and-Moon framing (the Earth at the centre, the Moon to one side, seen from above the
// orbit plane's side); the user's orbit and zoom stay free afterwards.
const ROUTE_VIEW_DIST = 800
const LIMITS = { moon: { min: 1.95, max: 1500 }, earth: { min: 7.5, max: 4000 } } as const

export default function Controls() {
  const ref = useRef<ComponentRef<typeof OrbitControls>>(null)
  const prev = useRef(new Vector3())
  const next = useRef(new Vector3())
  const lastFocus = useRef(useApp.getState().focus)
  const focus = useApp((s) => s.focus)
  // Distances scale with the displayed body size so the camera never ends up inside an enlarged body.
  const k = useApp((s) => (s.exaggerate ? SIZE_EXAGGERATION : 1))
  const seenView = useRef(useRoutes.getState().viewNonce)
  const lastK = useRef(useApp.getState().exaggerate ? SIZE_EXAGGERATION : 1)

  useFrame(({ camera }) => {
    const c = ref.current
    if (!c) return
    // Read the focus from the store (not the render closure) so a focus change made in the same tick is seen at once.
    const viewRequested = useRoutes.getState().viewNonce !== seenView.current
    const focus = viewRequested ? 'earth' : useApp.getState().focus
    if (focus === 'moon') {
      next.current.set(...moonPosition(new Date(useTime.getState().t)))
    } else {
      next.current.set(0, 0, 0)
    }
    // Move the camera with the target so the view doesn't jump; the user's orbit offset is kept, not reset
    camera.position.add(next.current).sub(prev.current)
    // Size switch: scale the camera's distance with the bodies, so the view keeps its look instead of ending up inside a body.
    const kNow = useApp.getState().exaggerate ? SIZE_EXAGGERATION : 1
    if (lastK.current !== kNow) {
      camera.position.sub(next.current).multiplyScalar(kNow / lastK.current).add(next.current)
      lastK.current = kNow
    }
    // When focus changes, jump to a sensible distance
    if (lastFocus.current !== focus) {
      lastFocus.current = focus
      const dist = (focus === 'moon' ? MOON_VIEW_DIST : EARTH_VIEW_DIST) * (useApp.getState().exaggerate ? SIZE_EXAGGERATION : 1)
      camera.position.sub(next.current).setLength(dist).add(next.current)
    }
    if (viewRequested) {
      seenView.current = useRoutes.getState().viewNonce
      if (useApp.getState().focus !== 'earth') useApp.setState({ focus: 'earth' })
      lastFocus.current = 'earth'
      const m = new Vector3(...moonPosition(new Date(useTime.getState().t)))
      // Perpendicular to the Earth-Moon line (horizontal), tilted up a little: both bodies and the line fit the view.
      const side = new Vector3(-m.z, 0, m.x).normalize()
      next.current.set(0, 0, 0)
      camera.position.copy(side.multiplyScalar(ROUTE_VIEW_DIST)).add(new Vector3(0, ROUTE_VIEW_DIST * 0.25, 0))
    }
    c.target.copy(next.current)
    prev.current.copy(next.current)
    c.update()
  })

  return (
    <OrbitControls
      ref={ref}
      enablePan={false}
      minDistance={LIMITS[focus].min * k}
      maxDistance={LIMITS[focus].max}
    />
  )
}