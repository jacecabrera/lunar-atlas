import { Canvas } from '@react-three/fiber'
import Sun from './Sun'
import Stars from './Stars'
import Moon, { MoonBody } from './Moon'
import Earth, { EarthBody } from './Earth'
import SunLight from './SunLight'
import Controls from './Controls'
import SceneErrorBoundary from './SceneErrorBoundary'
import MoonPicker from './MoonPicker'
import Routes from './Routes'

const AMBIENT = 0.35

// True scale (1 unit = 1000 km): the Moon is 1.74 units across 384 units from the Earth, the Sun ~149,600 units away.
// near 0.01 (10 km) lets the camera come within ~200 km of the lunar surface; far 3e6 keeps the Sun (1.5e5) and the
// star sphere (4e5) inside the frustum; the logarithmic depth buffer keeps depth precision over that span.
export default function Scene() {
  return (
    <Canvas gl={{ logarithmicDepthBuffer: true }} camera={{ fov: 50, near: 0.01, far: 3_000_000, position: [0, 20, 55] }}>
      <color attach="background" args={['#04070d']} />
      <ambientLight intensity={AMBIENT} />
      <SunLight />
      <Sun />
      <Stars />
      {/* Textures load without throwing (useOptionalTexture); the boundaries remain a safety net for other render errors. */}
      <SceneErrorBoundary label="Earth" fallback={<EarthBody />}><Earth /></SceneErrorBoundary>
      <SceneErrorBoundary label="Moon" fallback={<MoonBody />}><Moon /></SceneErrorBoundary>
      <Routes />
      <Controls />
      <MoonPicker />
    </Canvas>
  )
}
