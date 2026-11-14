import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'

const EARTH_R = 6.371   // 1 scene unit = 1000 km
const MOON_R = 1.737
const MOON_DIST = 384.4

export default function Scene() {
  return (
    <Canvas
      gl={{ logarithmicDepthBuffer: true }}
      camera={{ fov: 50, near: 0.1, far: 1_000_000, position: [MOON_DIST / 2, 150, 450] }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[1, 0.5, 1]} intensity={2} />

      <mesh>
        <sphereGeometry args={[EARTH_R, 64, 64]} />
        <meshStandardMaterial color="#3a6ea5" />
      </mesh>

      <mesh position={[MOON_DIST, 0, 0]}>
        <sphereGeometry args={[MOON_R, 64, 64]} />
        <meshStandardMaterial color="#aaaaaa" />
      </mesh>

      <OrbitControls target={[MOON_DIST / 2, 0, 0]} enablePan={false} />
    </Canvas>
  )
}