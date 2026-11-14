import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import type { Group } from 'three'
import { moonPosition } from '../physics/ephemeris'
import { useTime } from '../state/timeStore'
import { useApp } from '../state/appStore'

const MOON_R = 1.737 // 1 scene unit = 1000 km
const EXAGGERATION = 10
const OBLIQUITY = (23.4393 * Math.PI) / 180 // tilt of ecliptic vs equator

export default function Moon() {
  const ref = useRef<Group>(null!)
  const map = useTexture('/textures/moon.jpg')
  const k = useApp((s) => (s.exaggerate ? EXAGGERATION : 1))

  useFrame(() => {
    const d = new Date(useTime.getState().t)
    const g = ref.current
    g.position.set(...moonPosition(d))
    // Placeholder orientation: near side faces Earth, north pole ~ ecliptic north
    g.up.set(0, Math.cos(OBLIQUITY), Math.sin(OBLIQUITY))
    g.lookAt(0, 0, 0)
  })

  return (
    <group ref={ref}>
      <mesh rotation-y={-Math.PI / 2} scale={k}>
        <sphereGeometry args={[MOON_R, 64, 64]} />
        <meshStandardMaterial map={map} />
        <axesHelper args={[3]} />
      </mesh>
    </group>
  )
}