import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { DirectionalLight } from 'three'
import { sunDirection } from '../sim'
import { useTime } from '../state/timeStore'

export default function SunLight() {
  const ref = useRef<DirectionalLight>(null!)

  useFrame(() => {
    const d = new Date(useTime.getState().t)
    const [x, y, z] = sunDirection(d)
    ref.current.position.set(x * 1000, y * 1000, z * 1000)
  })

  return <directionalLight ref={ref} intensity={3} />
}