import { useRef } from 'react'
import type { ComponentRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Vector3 } from 'three'
import { moonPosition } from '../physics/ephemeris'
import { useTime } from '../state/timeStore'
import { useApp } from '../state/appStore'

const MOON_VIEW_DIST = 60
const EARTH_VIEW_DIST = 1000

export default function Controls() {
  const ref = useRef<ComponentRef<typeof OrbitControls>>(null)
  const prev = useRef(new Vector3())
  const next = useRef(new Vector3())
  const lastFocus = useRef(useApp.getState().focus)
  const focus = useApp((s) => s.focus)

  useFrame(({ camera }) => {
    const c = ref.current
    if (!c) return
    if (focus === 'moon') {
      next.current.set(...moonPosition(new Date(useTime.getState().t)))
    } else {
      next.current.set(0, 0, 0)
    }
    // Move the camera with the target so the view doesn't jump
    camera.position.add(next.current).sub(prev.current)
    // When focus changes, jump to a sensible distance
    if (lastFocus.current !== focus) {
      lastFocus.current = focus
      const dist = focus === 'moon' ? MOON_VIEW_DIST : EARTH_VIEW_DIST
      camera.position.sub(next.current).setLength(dist).add(next.current)
    }
    c.target.copy(next.current)
    prev.current.copy(next.current)
    c.update()
  })

  return (
    <OrbitControls
      ref={ref}
      enablePan={false}
      minDistance={focus === 'moon' ? 25 : 80}
      maxDistance={5000}
    />
  )
}