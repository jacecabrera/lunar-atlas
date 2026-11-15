import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Mesh } from 'three'
import { pickMoon } from './pick'
import { useCustomSites } from '../state/customSites'

// Hover readout and click-to-fill for custom sites (step 19). Light work only: a raycast against three meshes every
// 100 ms while the pointer is over the canvas (also when the pointer is still and the Moon or camera moves); no
// evaluation is started here. A click (pointer moved < 5 px, primary button) fills the editor's coordinates; drags
// that rotate or zoom the view do not. The canvas only covers the area left of the sidebar, and R3F's pointer is
// relative to the canvas rectangle.
const HOVER_INTERVAL_MS = 100
const CLICK_SLOP_PX = 5

export default function MoonPicker() {
  const { gl, camera, scene, raycaster, pointer } = useThree()
  const inside = useRef(false)
  const last = useRef(0)
  const down = useRef<{ x: number; y: number } | null>(null)

  const bodies = () => ['earth', 'moon', 'sun'].map((n) => scene.getObjectByName(n)).filter((o): o is Mesh => !!o)
  const pickNow = () => {
    const list = bodies()
    const moon = list.find((o) => o.name === 'moon')
    if (!moon) return null
    raycaster.setFromCamera(pointer, camera)
    return pickMoon(raycaster, list, moon)
  }

  useEffect(() => {
    const el = gl.domElement
    const enter = () => { inside.current = true }
    const leave = () => { inside.current = false; useCustomSites.getState().setHover(null) }
    const onDown = (e: PointerEvent) => { if (e.button === 0) down.current = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      const d = down.current
      down.current = null
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_SLOP_PX) return
      const hit = pickNow()
      if (hit) useCustomSites.getState().editEditor({ lat: Number(hit.lat.toFixed(4)), lon: Number(hit.lon.toFixed(4)) })
    }
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointermove', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointermove', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  })

  useFrame(() => {
    if (!inside.current) return
    const t = performance.now()
    if (t - last.current < HOVER_INTERVAL_MS) return
    last.current = t
    const hit = pickNow()
    const prev = useCustomSites.getState().hover
    if (!hit) { if (prev) useCustomSites.getState().setHover(null); return }
    if (!prev || Math.abs(prev.lat - hit.lat) > 1e-4 || Math.abs(prev.lon - hit.lon) > 1e-4) useCustomSites.getState().setHover(hit)
  })
  return null
}
