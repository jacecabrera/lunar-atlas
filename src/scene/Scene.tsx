import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import Sun from './Sun'
import Stars from './Stars'
import Moon from './Moon'
import SunLight from './SunLight'
import Controls from './Controls'
import { useApp } from '../state/appStore'

const AMBIENT = 0.35 // was 0.05; raise or lower to taste

const EARTH_R = 6.371
const EXAGGERATION = 10

export default function Scene() {
    const k = useApp((s) => (s.exaggerate ? EXAGGERATION : 1))

    return (
        <Canvas
            gl={{ logarithmicDepthBuffer: true }}
            camera={{ fov: 50, near: 0.1, far: 1_000_000, position: [0, 500, 900] }}
        >
            <ambientLight intensity={AMBIENT} />
            <SunLight />
            <Sun />
            <Stars />

            <mesh scale={k}>
                <sphereGeometry args={[EARTH_R, 64, 64]} />
                <meshStandardMaterial color="#3a6ea5" />
            </mesh>

            <Suspense fallback={null}>
                <Moon />
            </Suspense>

            <Controls />
        </Canvas>
    )
}
