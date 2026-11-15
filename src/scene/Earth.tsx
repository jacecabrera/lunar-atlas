import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Matrix4 } from 'three'
import type { Group, Texture } from 'three'
import { sceneState, SCENE_RADII } from '../sim/scene'
import { useTime } from '../state/timeStore'
import { publicUrl } from './assets'
import { useOptionalTexture } from './useOptionalTexture'
import { useApp, SIZE_EXAGGERATION } from '../state/appStore'

/** The Earth at true size in the pose of the current simulation time; untextured when `map` is absent (fallback). */
export function EarthBody({ map }: { map?: Texture }) {
  const ref = useRef<Group>(null!)
  const rot = useRef(new Matrix4())
  const k = useApp((s) => (s.exaggerate ? SIZE_EXAGGERATION : 1))
  useFrame(() => {
    const R = sceneState(new Date(useTime.getState().t)).earthRotation
    rot.current.set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1)
    ref.current.quaternion.setFromRotationMatrix(rot.current)
  })
  return (
    <group ref={ref} scale={k}>
      <mesh name="earth">
        <sphereGeometry args={[SCENE_RADII.earth, 96, 96]} />
        {/* Separate material instances (key): a map added later needs a fresh shader, not a patched one. */}
        {map ? <meshStandardMaterial key="textured" map={map} /> : <meshStandardMaterial key="plain" color="#3a5f8a" />}
      </mesh>
    </group>
  )
}

export default function Earth() {
  const map = useOptionalTexture(publicUrl('textures/earth.jpg'), 'Earth texture')
  return <EarthBody map={map ?? undefined} />
}
