import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { CanvasTexture, Color, Group, Points as ThreePoints, Sprite, SpriteMaterial } from 'three'
import type { InterleavedBufferAttribute } from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { useCustomSites } from '../state/customSites'
import { useApp, SIZE_EXAGGERATION } from '../state/appStore'
import { useRouteModel, useDemoVisible } from './useRouteModel'
import { SCENE_RADII, moonPosition } from '../sim/scene'
import { latLonToMoonLocal } from './moonPicking'
import { moonMesh } from './moonMesh'
import {
  ROUTE_SAMPLES, DEMO_COLOUR, DEMO_LABEL, ILLUSTRATIVE_LABEL, EARTH_MARKER_LIFT_UNITS, MOON_MARKER_LIFT_UNITS,
  bezierPoints, demoEndpoints, draftMarker, drawableRoutes, exaggerateRoute,
} from './routeModel'
import type { Route, SiteMarker, Vec3 } from './routeModel'

// 3D layer of step 20: fat lines (Line2, so the width is in pixels and visible at every zoom), pixel-size point markers
// and short labels. Lines and markers never take part in picking (raycast disabled; MoonPicker only tests the bodies).
// Geometry and materials created here are disposed when replaced or unmounted.

const LINE_WIDTH_PX = 2
const DEMO_LINE_WIDTH_PX = 2.5
const MARKER_PX = 16

// ─── Marker shapes (white canvas textures tinted by the material colour) ─────

type Shape = 'disc' | 'ring' | 'diamond'
const shapeTextures = new Map<Shape, CanvasTexture>()
function shapeTexture(shape: Shape): CanvasTexture {
  let t = shapeTextures.get(shape)
  if (t) return t
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = g.strokeStyle = '#fff'
  g.lineWidth = 9
  g.beginPath()
  if (shape === 'disc') g.arc(32, 32, 26, 0, Math.PI * 2)
  else if (shape === 'ring') g.arc(32, 32, 23, 0, Math.PI * 2)
  else { g.moveTo(32, 3); g.lineTo(61, 32); g.lineTo(32, 61); g.lineTo(3, 32); g.closePath() }
  if (shape === 'ring') g.stroke(); else g.fill()
  t = new CanvasTexture(c)
  shapeTextures.set(shape, t)
  return t
}

type MarkerProps = { shape: Shape; color: string; position?: Vec3; size?: number; objectRef?: (p: ThreePoints | null) => void }
/** One pixel-size marker at the object's own position (a single vertex at the origin). */
function Marker({ shape, color, position, size = MARKER_PX, objectRef }: MarkerProps) {
  const dpr = useThree((s) => s.viewport.dpr)
  const map = useMemo(() => shapeTexture(shape), [shape])
  return (
    <points ref={objectRef} position={position} frustumCulled={false} raycast={() => null} renderOrder={5}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array(3), 3]} /></bufferGeometry>
      <pointsMaterial map={map} color={color} size={size * dpr} sizeAttenuation={false} transparent alphaTest={0.35} depthWrite={false} />
    </points>
  )
}

// ─── Fat line ────────────────────────────────────────────────────────────────

type FatLineProps = { points: Vec3[]; color: string; width: number; /** Dashed, low-key line (the demo route). */ dashed?: boolean; /** Called every frame to rewrite `points` in place (the demo route). */ frame?: (points: Vec3[]) => void }
function FatLine({ points, color, width, dashed = false, frame }: FatLineProps) {
  const size = useThree((s) => s.size)
  const { line, geometry, material } = useMemo(() => {
    const geometry = new LineGeometry()
    geometry.setPositions(points.flat())
    const material = new LineMaterial({ color: new Color(color).getHex(), linewidth: width, transparent: true, depthWrite: false })
    if (dashed) {
      material.dashed = true
      material.dashSize = 3
      material.gapSize = 5
      material.dashScale = 1
    }
    const line = new Line2(geometry, material)
    // computeLineDistances lives on the line object (not the geometry): it creates the per-segment distance attributes the dashes use.
    if (dashed) line.computeLineDistances()
    line.frustumCulled = false
    line.renderOrder = 4
    line.raycast = () => null
    return { line, geometry, material }
    // The static line is rebuilt (and the old one disposed) when its points, colour or width change.
  }, [points, color, width, dashed])
  const buffer = useRef<InterleavedBufferAttribute | null>(null)
  const distances = useRef<InterleavedBufferAttribute | null>(null)
  useEffect(() => {
    buffer.current = geometry.attributes.instanceStart as InterleavedBufferAttribute
    distances.current = (geometry.attributes.instanceDistanceStart as InterleavedBufferAttribute | undefined) ?? null
    return () => { buffer.current = null; distances.current = null; geometry.dispose(); material.dispose() }
  }, [geometry, material])
  useEffect(() => { material.resolution.set(size.width, size.height) }, [material, size.width, size.height])
  useFrame(() => {
    if (!frame) return
    frame(points)
    // Write the segments into the existing interleaved buffer: no new buffers per frame.
    const attr = buffer.current
    if (!attr) return
    const arr = attr.data.array as Float32Array
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1], o = i * 6
      arr[o] = a[0]; arr[o + 1] = a[1]; arr[o + 2] = a[2]; arr[o + 3] = b[0]; arr[o + 4] = b[1]; arr[o + 5] = b[2]
    }
    attr.data.needsUpdate = true
    // A dashed line that moves needs its cumulative distances rewritten too (in place, same buffer): start and end per segment.
    const d = distances.current
    if (d) {
      const da = d.data.array as Float32Array
      let run = 0
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1]
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        da[2 * i] = run; da[2 * i + 1] = run + len
        run += len
      }
      d.data.needsUpdate = true
    }
  })
  return <primitive object={line} />
}

/** Text in the scene: a sprite of constant on-screen size (no DOM overlay), never picked, disposed when replaced. */
function TextLabel({ text, color, px = 12, slot = 0 }: { text: string; color: string; px?: number; slot?: number }) {
  const size = useThree((s) => s.size)
  const camera = useThree((s) => s.camera)
  const { sprite, material, texture, aspect } = useMemo(() => {
    const c = document.createElement('canvas')
    // The canvas cannot use a CSS variable name, so the theme's font stack is read from the root element.
    const stack = (typeof getComputedStyle !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()) || 'sans-serif'
    const font = `600 ${Math.round(px * 2)}px ${stack}`
    const g0 = c.getContext('2d')!
    g0.font = font
    const w = Math.ceil(g0.measureText(text).width) + 12, h = Math.round(px * 2) + 12
    c.width = w; c.height = h
    const g = c.getContext('2d')!
    g.font = font; g.textBaseline = 'middle'
    g.lineWidth = 5; g.strokeStyle = '#000'; g.lineJoin = 'round'
    g.strokeText(text, 6, h / 2); g.fillStyle = color; g.fillText(text, 6, h / 2)
    const texture = new CanvasTexture(c)
    const material = new SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true })
    const sprite = new Sprite(material)
    sprite.center.set(1.03, -0.2 - slot * 1.15) // text ends at the anchor (stays on screen); slots stack labels of overlapping routes
    sprite.renderOrder = 6
    sprite.raycast = () => null
    return { sprite, material, texture, aspect: w / h }
  }, [text, color, px, slot])
  useEffect(() => () => { texture.dispose(); material.dispose() }, [texture, material])
  // Pixel height -> sprite scale for an unattenuated sprite: the visible height at unit distance is 2 tan(fov/2).
  const fov = 'fov' in camera ? (camera.fov as number) : 50
  const hScale = ((px + 6) / size.height) * 2 * Math.tan((fov * Math.PI) / 360)
  return <primitive object={sprite} scale={[hScale * aspect, hScale, 1]} />
}

function FormalRoute({ route: base, slot }: { route: Extract<Route, { status: 'ok' }>; slot: number }) {
  const k = useApp((s) => (s.exaggerate ? SIZE_EXAGGERATION : 1))
  // With the size switch on, the endpoints are scaled out from their body's centre (display only); computed once per change.
  const route = useMemo(() => exaggerateRoute(base, moonPosition(new Date(base.landingTimeMs)), k), [base, k])
  return (
    <>
      <FatLine points={route.points} color={route.colour} width={LINE_WIDTH_PX} />
      <Marker shape="disc" color={route.colour} position={route.startMarker} size={MARKER_PX * 0.8} />
      <Marker shape="disc" color={route.colour} position={route.endMarker} size={MARKER_PX * 0.8} />
      <group position={route.mid}><TextLabel text={`${route.name} · ${ILLUSTRATIVE_LABEL}`} color={route.colour} slot={slot} /></group>
    </>
  )
}

/** The demo route: facing-side endpoints of the two bodies at the current scene positions (display only). */
function DemoRoute() {
  const points = useMemo(() => bezierPoints([0, 0, 0], [0, 0, 1]), [])
  const earthEnd = useRef<ThreePoints | null>(null)
  const moonEnd = useRef<ThreePoints | null>(null)
  const label = useRef<Group>(null)
  const frame = (pts: Vec3[]) => {
    const moonGroup = moonMesh.current?.parent
    if (!moonGroup) return
    const m = moonGroup.position
    const kk = useApp.getState().exaggerate ? SIZE_EXAGGERATION : 1 // size switch: the facing surfaces move out with the bodies
    const { earth, moon } = demoEndpoints([m.x, m.y, m.z], kk)
    bezierPoints(earth, moon, ROUTE_SAMPLES, undefined, pts)
    const lift = (p: Vec3, r: number, lift: number): Vec3 => { const k = (r + lift) / r; return [p[0] * k, p[1] * k, p[2] * k] }
    const e = lift(earth, SCENE_RADII.earth * kk, EARTH_MARKER_LIFT_UNITS)
    earthEnd.current?.position.set(...e)
    // Moon end: lift away from the Moon's centre.
    const c: Vec3 = [m.x, m.y, m.z]
    const d: Vec3 = [moon[0] - c[0], moon[1] - c[1], moon[2] - c[2]]
    const kMoon = (SCENE_RADII.moon * kk + MOON_MARKER_LIFT_UNITS) / (SCENE_RADII.moon * kk)
    moonEnd.current?.position.set(c[0] + d[0] * kMoon, c[1] + d[1] * kMoon, c[2] + d[2] * kMoon)
    const mid = pts[ROUTE_SAMPLES / 2]
    label.current?.position.set(mid[0], mid[1], mid[2])
  }
  return (
    <>
      <FatLine points={points} color={DEMO_COLOUR} width={DEMO_LINE_WIDTH_PX} dashed frame={frame} />
      <Marker shape="diamond" color={DEMO_COLOUR} size={MARKER_PX * 1.1} objectRef={(p) => { earthEnd.current = p }} />
      <Marker shape="diamond" color={DEMO_COLOUR} size={MARKER_PX * 1.1} objectRef={(p) => { moonEnd.current = p }} />
      <group ref={label}><TextLabel text={DEMO_LABEL} color={DEMO_COLOUR} px={13} /></group>
    </>
  )
}

/** Routes in world space (EQJ-derived scene coordinates) plus the demo route when it applies. */
export default function Routes() {
  const model = useRouteModel()
  const demo = useDemoVisible()
  return (
    <>
      {drawableRoutes(model).map((r, i) => <FormalRoute key={r.id} route={r} slot={i} />)}
      {demo && <DemoRoute />}
    </>
  )
}

/** Markers on the Moon surface (children of the Moon group, so they turn with the Moon at the displayed time). */
export function MoonSiteMarkers() {
  const model = useRouteModel()
  const editor = useCustomSites((s) => s.editor)
  const draft = useMemo(() => draftMarker(editor), [editor])
  const all: SiteMarker[] = draft ? [...model.markers, draft] : model.markers
  return (
    <>
      {all.map((m) => (
        <Marker key={`${m.kind}-${m.id}`} shape={m.kind === 'valid' ? 'disc' : 'ring'} color={m.colour}
          position={latLonToMoonLocal(m.lat, m.lon, SCENE_RADII.moon + MOON_MARKER_LIFT_UNITS)} size={m.kind === 'valid' ? MARKER_PX : MARKER_PX * 1.15} />
      ))}
    </>
  )
}
