// Point markers and illustrative routes (step 20): pure model, no three.js and no React.
//
// A route is drawn for every valid recommendation and every confirmed, still valid custom site (at most 3 + 9). Its
// endpoints follow the step-14 convention (sim/frames.ts): the Earth launch site at the estimated launch instant and the
// lunar destination at the landing instant, both geocentric EQJ geometric positions, then the one display transform
// (physics/coords toScene, 1 unit = 1000 km). The curve between them is a quadratic Bezier whose bow is purely visual:
// its length feeds no physical result. Transit estimates come from TaskResult.transits (recommendations) or from the
// custom site's own Worker result (computed once with estimateTransit); nothing is computed per frame, and a missing or
// failed estimate gives a reason, never a 0 or an example value.
//
// The demo route is a different thing: a fixed example between the facing-side surface points of the two bodies at the
// current scene positions. It has no times, no site, no score and no eligibility.
import { toScene } from '../physics/coords'
import { MOON_R_KM } from '../physics/siteSky'
import { earthSiteGeocentric, moonSiteGeocentric } from '../sim/frames'
import { loadCandidateCatalog } from '../sim/catalog'
import { validateMissionDraft } from '../sim/mission'
import type { MissionDraft, MissionInput } from '../sim/mission'
import type { TaskState, TransitEstimate } from '../sim'
import { SCENE_RADII } from '../sim/scene'
import { isValidCustom, validCoordinate } from '../state/customSitesModel'
import type { CustomSite } from '../state/customSitesModel'

export type Vec3 = [number, number, number]

export const ILLUSTRATIVE_LABEL = 'Illustrative trajectory'
export const DEMO_LABEL = 'Demo route — illustrative only'
export const ROUTE_SAMPLES = 96
/** Bow of the curve as a fraction of the endpoint distance (visual only). */
export const CURVE_BOW = 0.18
/** Display-only lift of a marker above the surface, scene units: 30 km above the Earth (beats the ellipsoid/sphere difference of up to ~21 km), 5 km above the Moon. */
export const EARTH_MARKER_LIFT_UNITS = 0.03
export const MOON_MARKER_LIFT_UNITS = 0.005
/** Dim blue-grey of the demo route; not in either palette below. */
export const DEMO_COLOUR = '#5d7390'

// Stable colours, monochrome cool light-blue family (docs/style-plan.md): catalogue sites by their position in the
// catalogue, custom sites by their sequence number. All values within a palette stay distinct (tests assert that).
const CATALOGUE_PALETTE = ['#9cc8f2', '#7fb4e8', '#a8d3ff', '#6ea3d8', '#8fc1f0', '#b3dcf7', '#5f97cc', '#c3e4f8', '#4f8bc4', '#7aa8d9', '#94b6dd', '#69a6e0']
const CUSTOM_PALETTE = ['#8fb4d8', '#6f9ec9', '#a3c4e4', '#5b8fc0', '#b7d2ea', '#4a7fb4', '#86a7cc', '#9dbddd', '#73a2cf']

const catalogue = loadCandidateCatalog()
export const catalogueName = (id: string) => catalogue.candidates.find((c) => c.id === id)?.name ?? id
export const isCatalogueCoordinate = (lat: number, lon: number) => catalogue.candidates.some((c) => Math.abs(c.coordinate.lat - lat) < 1e-9 && Math.abs(c.coordinate.lon - lon) < 1e-9)

// Search results have their own colours (by rank), distinct from the catalogue and custom palettes.
const SEARCH_PALETTE = ['#bfe3ff', '#8fc1f2', '#5d93c9']

export function routeColour(kind: RouteKind, siteId: string, rank = 1): string {
  if (kind === 'search') return SEARCH_PALETTE[(Math.max(1, rank) - 1) % SEARCH_PALETTE.length]
  if (kind === 'recommendation') {
    const i = catalogue.candidates.findIndex((c) => c.id === siteId)
    return CATALOGUE_PALETTE[(i < 0 ? 0 : i) % CATALOGUE_PALETTE.length]
  }
  const n = Number(/(\d+)$/.exec(siteId)?.[1] ?? 0)
  return CUSTOM_PALETTE[n % CUSTOM_PALETTE.length]
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: Vec3): Vec3 => { const l = len(a); return l > 0 ? scale(a, 1 / l) : [0, 0, 0] }

/** Control point: the chord midpoint pushed towards scene "up" (the part of Y perpendicular to the chord). */
export function bowControl(a: Vec3, b: Vec3, bow = CURVE_BOW): Vec3 {
  const chord = sub(b, a)
  const d = len(chord)
  const mid = scale(add(a, b), 0.5)
  const c = unit(chord)
  let up: Vec3 = sub([0, 1, 0], scale(c, c[1]))
  if (len(up) < 1e-6) up = sub([1, 0, 0], scale(c, c[0]))
  return add(mid, scale(unit(up), bow * d))
}

/** Quadratic Bezier from a to b with the visual bow; the first and last points are exactly a and b. */
export function bezierPoints(a: Vec3, b: Vec3, n = ROUTE_SAMPLES, bow = CURVE_BOW, out?: Vec3[]): Vec3[] {
  const c = bowControl(a, b, bow)
  const pts = out ?? Array.from({ length: n + 1 }, () => [0, 0, 0] as Vec3)
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t
    const p = pts[i]
    for (let k = 0; k < 3; k++) p[k] = u * u * a[k] + 2 * u * t * c[k] + t * t * b[k]
  }
  pts[0] = [...a]
  pts[n] = [...b]
  return pts
}

/** Facing-side endpoints of the demo route for the Moon centre at `moonPosition` (scene units); the Earth is at the origin. */
export function demoEndpoints(moonPosition: Vec3, k = 1): { earth: Vec3; moon: Vec3 } {
  const dir = unit(moonPosition)
  return { earth: scale(dir, SCENE_RADII.earth * k), moon: sub(moonPosition, scale(dir, SCENE_RADII.moon * k)) }
}

/**
 * Display of a drawable route when the bodies are drawn k times larger (the size switch): each endpoint is scaled away from its
 * own body's centre (the Earth at the origin, the Moon at its landing-time position), so the curve and markers still start on
 * the enlarged surfaces. Display only; with k = 1 the route is returned unchanged.
 */
export function exaggerateRoute(r: Extract<Route, { status: 'ok' }>, moonCentreAtLanding: Vec3, k: number): Extract<Route, { status: 'ok' }> {
  if (k === 1) return r
  const about = (p: Vec3, c: Vec3): Vec3 => add(c, scale(sub(p, c), k))
  const origin: Vec3 = [0, 0, 0]
  const start = about(r.start, origin), end = about(r.end, moonCentreAtLanding)
  const points = bezierPoints(start, end)
  return { ...r, start, end, startMarker: about(r.startMarker, origin), endMarker: about(r.endMarker, moonCentreAtLanding), points, mid: points[ROUTE_SAMPLES / 2] }
}

// ─── Formal routes ─────────────────────────────────────────────────────────

export type RouteKind = 'recommendation' | 'custom' | 'search'
type RouteBase = { id: string; siteId: string; name: string; colour: string; kind: RouteKind; lat: number; lon: number }
export type Route =
  | (RouteBase & {
      status: 'ok'
      launchTimeMs: number; landingTimeMs: number
      /** Endpoints of the curve, scene units. */
      start: Vec3; end: Vec3
      /** Marker positions (lifted a few km, display only). */
      startMarker: Vec3; endMarker: Vec3
      points: Vec3[]; mid: Vec3
      notes: string[]
    })
  | (RouteBase & { status: 'unavailable'; reason: string })

const KM_TO_SCENE = 1 / 1000
const toSceneKm = (v: Vec3): Vec3 => toScene({ x: v[0], y: v[1], z: v[2] }, KM_TO_SCENE)

function routeFor(base: RouteBase, transit: TransitEstimate | undefined, input: MissionInput | null): Route {
  const unavailable = (reason: string): Route => ({ ...base, status: 'unavailable', reason })
  if (!input) return unavailable('The mission inputs of this result are not available')
  if (!transit) return unavailable('No transit estimate for this point')
  if (transit.status !== 'ok' || transit.launchTimeMs === null) {
    return unavailable(`Transit estimate unavailable (${transit.status}): ${transit.reasons.map((r) => r.message).join('; ') || 'no reason given'}`)
  }
  try {
    const start = toSceneKm(earthSiteGeocentric({ lat: input.launchSite.lat, lon: input.launchSite.lon }, transit.launchTimeMs).positionKm)
    const end = toSceneKm(moonSiteGeocentric({ lat: base.lat, lon: base.lon, radiusKm: MOON_R_KM }, input.landingTimeMs).positionKm)
    const startMarker = toSceneKm(earthSiteGeocentric({ lat: input.launchSite.lat, lon: input.launchSite.lon, heightM: EARTH_MARKER_LIFT_UNITS * 1e6 }, transit.launchTimeMs).positionKm)
    const endMarker = toSceneKm(moonSiteGeocentric({ lat: base.lat, lon: base.lon, radiusKm: MOON_R_KM + MOON_MARKER_LIFT_UNITS * 1000 }, input.landingTimeMs).positionKm)
    const points = bezierPoints(start, end)
    return {
      ...base, status: 'ok', launchTimeMs: transit.launchTimeMs, landingTimeMs: input.landingTimeMs, start, end, startMarker, endMarker, points, mid: points[ROUTE_SAMPLES / 2],
      notes: transit.withinValidatedRange === false ? ['Outside the span checked against Horizons (no accuracy record)'] : [],
    }
  } catch (e) {
    return unavailable(`Endpoint could not be computed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export type SiteMarker = { id: string; name: string; lat: number; lon: number; colour: string; kind: 'valid' | 'draft' }

export type RouteModel = { routes: Route[]; markers: SiteMarker[] }

export const EMPTY_ROUTE_MODEL: RouteModel = { routes: [], markers: [] }

/** Validated input of the current draft, or null. Only meaningful while the task is done (any change makes it stale). */
export function inputOfDraft(draft: MissionDraft): MissionInput | null {
  const v = validateMissionDraft(draft)
  return v.ok ? v.input : null
}

/**
 * Routes and valid-site markers for a completed, current task. A stale, running, idle or failed task has none (a
 * stale result is out of date, so its routes are hidden). Order: recommendations in their ranked order, then custom
 * sites in list order.
 */
export function buildRouteModel(a: { task: TaskState; input: MissionInput | null; customs: CustomSite[]; maxCustom: number }): RouteModel {
  const { task } = a
  if (task.status !== 'done') return EMPTY_ROUTE_MODEL
  const routes: Route[] = []
  const markers: SiteMarker[] = []
  for (const r of task.result.recommendations) {
    const c = catalogue.candidates.find((x) => x.id === r.siteId)
    if (!c) continue
    const base: RouteBase = { id: `route-${r.siteId}`, siteId: r.siteId, name: c.name, colour: routeColour('recommendation', r.siteId), kind: 'recommendation', lat: c.coordinate.lat, lon: c.coordinate.lon }
    routes.push(routeFor(base, task.result.transits?.[r.siteId], a.input))
    markers.push({ id: r.siteId, name: c.name, lat: base.lat, lon: base.lon, colour: base.colour, kind: 'valid' })
  }
  // Whole-Moon search results are valid points too (their decision qualified); their transit was computed with them.
  for (const x of task.result.search?.results ?? []) {
    const base: RouteBase = { id: `route-${x.siteId}`, siteId: x.siteId, name: x.name, colour: routeColour('search', x.siteId, x.rank), kind: 'search', lat: x.lat, lon: x.lon }
    routes.push(routeFor(base, x.transit ?? undefined, a.input))
    markers.push({ id: x.siteId, name: x.name, lat: x.lat, lon: x.lon, colour: base.colour, kind: 'valid' })
  }
  for (const s of a.customs) {
    if (!validCoordinate(s) || !isValidCustom(s, task, a.customs.length, a.maxCustom)) continue
    const name = s.name || s.id
    const base: RouteBase = { id: `route-${s.id}`, siteId: s.id, name, colour: routeColour('custom', s.id), kind: 'custom', lat: s.lat!, lon: s.lon! }
    const transit = s.evaluation.state === 'assessed' ? s.evaluation.transit : undefined
    routes.push(routeFor(base, transit, a.input))
    markers.push({ id: s.id, name, lat: base.lat, lon: base.lon, colour: base.colour, kind: 'valid' })
  }
  return { routes, markers }
}

/** The unconfirmed editor point, when it has valid coordinates. Not counted anywhere; never has a route. */
export function draftMarker(editor: CustomSite): SiteMarker | null {
  if (!validCoordinate(editor)) return null
  return { id: editor.id, name: editor.name.trim() || 'Draft point', lat: editor.lat!, lon: editor.lon!, colour: '#dce9f8', kind: 'draft' }
}

/** Drawable routes (status ok). The demo is shown only when this is empty. */
export const drawableRoutes = (m: RouteModel) => m.routes.filter((r): r is Extract<Route, { status: 'ok' }> => r.status === 'ok')

export function showDemo(m: RouteModel, demoEnabled: boolean): boolean {
  return demoEnabled && drawableRoutes(m).length === 0
}

/** "2027-01-10 06:00:00 UTC" */
export const formatUtc = (ms: number) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`
