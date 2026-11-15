import { useRef } from 'react'
import type { ComponentRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Vector3 } from 'three'
import { moonPosition } from '../sim'
import { useTime } from '../state/timeStore'
import { useApp } from '../state/appStore'

// True-scale distances from the focused body's centre, scene units (1 unit = 1000 km). Moon radius 1.74, Earth 6.38.
const MOON_VIEW_DIST = 9
const EARTH_VIEW_DIST = 60
const LIMITS = { moon: { min: 1.95, max: 1500 }, earth: { min: 7.5, max: 4000 } } as const

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
    // Move the camera with the target so the view doesn't jump; the user's orbit offset is kept, not reset
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
      minDistance={LIMITS[focus].min}
      maxDistance={LIMITS[focus].max}
    />
  )
}