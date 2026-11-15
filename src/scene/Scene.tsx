import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import Sun from './Sun'
import Stars from './Stars'
import Moon from './Moon'
import Earth from './Earth'
import SunLight from './SunLight'
import Controls from './Controls'

const AMBIENT = 0.35 // was 0.05; raise or lower to taste

export default function Scene() {
    return (
        <Canvas
            gl={{ logarithmicDepthBuffer: true }}
            camera={{ fov: 50, near: 0.1, far: 1_000_000, position: [0, 500, 900] }}
        >
            <ambientLight intensity={AMBIENT} />
            <SunLight />
            <Sun />
            <Stars />

            <Suspense fallback={null}>
                <Earth />
                <Moon />
            </Suspense>

            <Controls />
        </Canvas>
    )
}
