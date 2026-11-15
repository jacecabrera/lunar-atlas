import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { Matrix4 } from 'three'
import type { Group, Texture } from 'three'
import { sceneState, SCENE_RADII } from '../sim/scene'
import { useTime } from '../state/timeStore'
import { publicUrl } from './assets'
import { moonMesh } from './moonMesh'


/** The Moon at true size in the pose of the current simulation time; untextured when `map` is absent (fallback). */
export function MoonBody({ map }: { map?: Texture }) {
  const ref = useRef<Group>(null!)
  const rot = useRef(new Matrix4())
  useFrame(() => {
    const g = ref.current
    const { moonPosition, moonRotation: R } = sceneState(new Date(useTime.getState().t))
    g.position.set(...moonPosition)
    rot.current.set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1)
    g.quaternion.setFromRotationMatrix(rot.current)
  })
  return (
    <group ref={ref}>
      <mesh name="moon" ref={(m) => { moonMesh.current = m }}>
        <sphereGeometry args={[SCENE_RADII.moon, 128, 128]} />
        {map ? <meshStandardMaterial map={map} /> : <meshStandardMaterial color="#8a8a8a" />}
      </mesh>
    </group>
  )
}

export default function Moon() {
  const map = useTexture(publicUrl('textures/moon.jpg'))
  return <MoonBody map={map} />
}
