import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sunPosition, SCENE_RADII } from '../sim/scene'
import { useTime } from '../state/timeStore'

// The Sun at its apparent geocentric position and true radius (about 149,600 units away, 695.7 units across), so its
// direction and angular size (about 0.27 deg) match the ephemeris. The glow sprite is decoration only.
const GLOW_SCALE = 12

function makeGlowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  grad.addColorStop(0, 'rgba(255,240,200,1)')
  grad.addColorStop(0.2, 'rgba(255,220,150,0.5)')
  grad.addColorStop(1, 'rgba(255,200,100,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 256)
  return new THREE.CanvasTexture(c)
}

export default function Sun() {
  const ref = useRef<THREE.Group>(null!)
  const glow = useMemo(() => makeGlowTexture(), [])
  useFrame(() => {
    ref.current.position.set(...sunPosition(new Date(useTime.getState().t)))
  })
  const r = SCENE_RADII.sun
  return (
    <group ref={ref}>
      <mesh name="sun">
        <sphereGeometry args={[r, 32, 32]} />
        <meshBasicMaterial color="#fff4d6" toneMapped={false} />
      </mesh>
      <sprite scale={[r * GLOW_SCALE, r * GLOW_SCALE, 1]} raycast={() => null}>
        <spriteMaterial map={glow} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
    </group>
  )
}
