import Sun from './Sun'
import Stars from './Stars'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import Moon from './Moon'
import SunLight from './SunLight'
import { useApp } from '../state/appStore'

const AMBIENT = 0.35

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

            <Moon />

            <OrbitControls enablePan={false} minDistance={80} maxDistance={5000} />
        </Canvas>
    )
}