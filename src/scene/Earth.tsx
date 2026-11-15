import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { Matrix4 } from 'three'
import type { Group, Texture } from 'three'
import { sceneState, SCENE_RADII } from '../sim/scene'
import { useTime } from '../state/timeStore'
import { publicUrl } from './assets'

/** The Earth at true size in the pose of the current simulation time; untextured when `map` is absent (fallback). */
export function EarthBody({ map }: { map?: Texture }) {
  const ref = useRef<Group>(null!)
  const rot = useRef(new Matrix4())
  useFrame(() => {
    const R = sceneState(new Date(useTime.getState().t)).earthRotation
    rot.current.set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1)
    ref.current.quaternion.setFromRotationMatrix(rot.current)
  })
  return (
    <group ref={ref}>
      <mesh name="earth">
        <sphereGeometry args={[SCENE_RADII.earth, 96, 96]} />
        {map ? <meshStandardMaterial map={map} /> : <meshStandardMaterial color="#3a5f8a" />}
      </mesh>
    </group>
  )
}

export default function Earth() {
  const map = useTexture(publicUrl('textures/earth.jpg'))
  return <EarthBody map={map} />
}
