import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Mesh } from 'three'
import { moonPosition } from '../physics/ephemeris'
import { useTime } from '../state/timeStore'
import { useApp } from '../state/appStore'

const MOON_R = 1.737 // 1 scene unit = 1000 km
const EXAGGERATION = 10

export default function Moon() {
  const ref = useRef<Mesh>(null!)
  const k = useApp((s) => (s.exaggerate ? EXAGGERATION : 1))

  useFrame(() => {
    const d = new Date(useTime.getState().t)
    ref.current.position.set(...moonPosition(d))
  })

  return (
    <mesh ref={ref} scale={k}>
      <sphereGeometry args={[MOON_R, 64, 64]} />
      <meshStandardMaterial color="#aaaaaa" />
    </mesh>
  )
}