import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Matrix4 } from 'three'
import type { Group, Texture } from 'three'
import { sceneState, SCENE_RADII } from '../sim/scene'
import { useTime } from '../state/timeStore'
import { publicUrl } from './assets'
import { useOptionalTexture } from './useOptionalTexture'
import { moonMesh } from './moonMesh'
import { useApp, SIZE_EXAGGERATION } from '../state/appStore'
import { MoonSiteMarkers } from './Routes'


/** The Moon at true size in the pose of the current simulation time; untextured when `map` is absent (fallback). */
export function MoonBody({ map, children }: { map?: Texture; children?: React.ReactNode }) {
  const ref = useRef<Group>(null!)
  const rot = useRef(new Matrix4())
  const k = useApp((s) => (s.exaggerate ? SIZE_EXAGGERATION : 1)) // the group scales, so the surface markers follow
  useFrame(() => {
    const g = ref.current
    const { moonPosition, moonRotation: R } = sceneState(new Date(useTime.getState().t))
    g.position.set(...moonPosition)
    rot.current.set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1)
    g.quaternion.setFromRotationMatrix(rot.current)
  })
  return (
    <group ref={ref} scale={k}>
      <mesh name="moon" ref={(m) => { moonMesh.current = m }}>
        <sphereGeometry args={[SCENE_RADII.moon, 128, 128]} />
        {/* Separate material instances (key): a map added later needs a fresh shader, not a patched one. */}
        {map ? <meshStandardMaterial key="textured" map={map} /> : <meshStandardMaterial key="plain" color="#8a8a8a" />}
      </mesh>
      {children}
    </group>
  )
}

export default function Moon() {
  const map = useOptionalTexture(publicUrl('textures/moon.jpg'), 'Moon texture')
  return <MoonBody map={map ?? undefined}><MoonSiteMarkers /></MoonBody>
}
