import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sunDirection } from '../physics/ephemeris'
import { useTime } from '../state/timeStore'

const SUN_DIST = 100_000
// The Sun's true angular radius is about 0.27 degrees
const SUN_R = SUN_DIST * Math.tan((0.27 * Math.PI) / 180)
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
    const [x, y, z] = sunDirection(new Date(useTime.getState().t))
    ref.current.position.set(x * SUN_DIST, y * SUN_DIST, z * SUN_DIST)
  })

  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[SUN_R, 32, 32]} />
        <meshBasicMaterial color="#fff4d6" toneMapped={false} />
      </mesh>
      <sprite scale={[SUN_R * GLOW_SCALE, SUN_R * GLOW_SCALE, 1]}>
        <spriteMaterial
          map={glow}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
    </group>
  )
}