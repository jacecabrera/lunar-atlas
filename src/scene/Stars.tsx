import { useMemo } from 'react'

const COUNT = 1800
const RADIUS = 400_000 // beyond the Sun (100,000), inside camera far (1,000,000)

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export default function Stars() {
  const positions = useMemo(() => {
    const rand = mulberry32(42) // fixed seed: same sky every reload
    const a = new Float32Array(COUNT * 3)
    for (let i = 0; i < COUNT; i++) {
      const z = 2 * rand() - 1 // uniform points on a sphere
      const phi = 2 * Math.PI * rand()
      const r = Math.sqrt(1 - z * z)
      a[3 * i] = RADIUS * r * Math.cos(phi)
      a[3 * i + 1] = RADIUS * z
      a[3 * i + 2] = RADIUS * r * Math.sin(phi)
    }
    return a
  }, [])

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color="#9db4d0"
        size={1.1}
        sizeAttenuation={false}
        opacity={0.75}
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  )
}