import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { Matrix4 } from 'three'
import type { Group } from 'three'
import { moonPosition } from '../physics/ephemeris'
import { moonSceneRotation } from '../physics/moonFrame'
import { useTime } from '../state/timeStore'
import { useApp } from '../state/appStore'

const MOON_R = 1.737 // 1 scene unit = 1000 km
const EXAGGERATION = 10

export default function Moon() {
  const ref = useRef<Group>(null!)
  const rot = useRef(new Matrix4())
  const map = useTexture('/textures/moon.jpg')
  const k = useApp((s) => (s.exaggerate ? EXAGGERATION : 1))

  useFrame(() => {
    const d = new Date(useTime.getState().t)
    const g = ref.current
    g.position.set(...moonPosition(d))
    const R = moonSceneRotation(d)
    rot.current.set(
      R[0][0], R[0][1], R[0][2], 0,
      R[1][0], R[1][1], R[1][2], 0,
      R[2][0], R[2][1], R[2][2], 0,
      0, 0, 0, 1,
    )
    g.quaternion.setFromRotationMatrix(rot.current)
  })

  return (
    <group ref={ref}>
      <mesh scale={k}>
        <sphereGeometry args={[MOON_R, 64, 64]} />
        <meshStandardMaterial map={map} />
        <axesHelper args={[3]} />
      </mesh>
    </group>
  )
}