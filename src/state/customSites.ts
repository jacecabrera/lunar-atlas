import { create } from 'zustand'
import { loadMissionDefaults } from '../sim'
import type { CustomSite } from './customSitesModel'
import { confirmCheck, validCoordinate } from './customSitesModel'
import type { TaskScheduler } from './taskScheduler'
import { useMission } from './missionStore'

// Custom sites store (step 19): one editor (draft, not yet confirmed) and up to limits.maxCustomSites confirmed sites.
// Evaluations go through the task scheduler (Worker); results are accepted only for the site's latest request.
// Clicking the Moon fills the editor's coordinates; it never confirms anything and never touches the clock or inputs.

export const MAX_CUSTOM_SITES = loadMissionDefaults().settings.limits.maxCustomSites

let seq = 0
const newSite = (): CustomSite => ({ id: `custom-${++seq}`, name: '', lat: null, lon: null, evaluation: { state: 'not-assessed' } })

type Store = {
  editor: CustomSite
  sites: CustomSite[]
  /** Moon coordinate under the pointer (sphere pick), or null. Display only. */
  hover: { lat: number; lon: number } | null
  setHover: (h: { lat: number; lon: number } | null) => void
  /** Change the editor; new coordinates void its evaluation. */
  editEditor: (patch: Partial<Pick<CustomSite, 'name' | 'lat' | 'lon'>>) => void
  renameSite: (id: string, name: string) => void
  /** New coordinates void the site's evaluation (and validity) until it is checked again. */
  moveSite: (id: string, lat: number | null, lon: number | null) => void
  removeSite: (id: string) => void
  /** Ask the scheduler to evaluate a site (editor or confirmed). Returns why it could not start, or null. */
  check: (id: string) => string | null
  /** Move the editor into the confirmed list when every rule holds. Returns the reasons when it does not. */
  confirmEditor: () => string[]
  /** Results from the scheduler's site sink. */
  applyResult: (siteId: string, requestId: string, key: string, assessment: import('../sim').SiteAssessment, transit?: import('../sim').TransitEstimate, pointData?: import('../sim').PointData) => void
  applyError: (siteId: string, requestId: string, key: string, message: string) => void
  /** Confirmed Clear / Reset input. */
  resetConfirmed: () => void
}

let scheduler: (() => TaskScheduler) | null = null
/** Wired once in main.tsx (keeps this store free of a hard dependency on the Worker module). */
export function setCustomSiteScheduler(get: () => TaskScheduler) { scheduler = get }

const update = (s: Store, id: string, f: (x: CustomSite) => CustomSite): Partial<Store> =>
  s.editor.id === id ? { editor: f(s.editor) } : { sites: s.sites.map((x) => (x.id === id ? f(x) : x)) }

export const useCustomSites = create<Store>((set, get) => ({
  editor: newSite(),
  sites: [],
  hover: null,
  setHover: (hover) => set({ hover }),
  editEditor: (patch) => {
    const e = get().editor
    const moved = ('lat' in patch && patch.lat !== e.lat) || ('lon' in patch && patch.lon !== e.lon)
    if (moved) scheduler?.().forgetSite(e.id)
    set({ editor: { ...e, ...patch, evaluation: moved ? { state: 'not-assessed' } : e.evaluation } })
  },
  renameSite: (id, name) => set((s) => update(s, id, (x) => ({ ...x, name }))),
  moveSite: (id, lat, lon) => {
    scheduler?.().forgetSite(id)
    set((s) => update(s, id, (x) => ({ ...x, lat, lon, evaluation: { state: 'not-assessed' } })))
  },
  removeSite: (id) => {
    scheduler?.().forgetSite(id) // a late result can no longer land anywhere
    set((s) => ({ sites: s.sites.filter((x) => x.id !== id) }))
  },
  check: (id) => {
    const s = get()
    const site = s.editor.id === id ? s.editor : s.sites.find((x) => x.id === id)
    if (!site) return 'Unknown site'
    if (!validCoordinate(site)) return 'Enter a valid latitude (-90..90) and longitude (-180..180)'
    if (!scheduler) return 'Scheduler not available'
    const out = scheduler().evaluateSite({ id: site.id, name: site.name || site.id, lat: site.lat!, lon: site.lon! })
    if (!out.accepted) return out.reason
    if (!out.fromCache) set((st) => update(st, id, (x) => ({ ...x, evaluation: { state: 'evaluating', requestId: out.requestId, key: out.key } })))
    return null
  },
  confirmEditor: () => {
    const s = get()
    const check = confirmCheck(s.editor, useMission.getState().task, s.sites.length, MAX_CUSTOM_SITES)
    if (!check.ok) return check.reasons
    const site = { ...s.editor, name: s.editor.name.trim() || `Custom site ${s.sites.length + 1}` }
    set({ sites: [...s.sites, site], editor: newSite() })
    return []
  },
  applyResult: (siteId, requestId, key, assessment, transit, pointData) => set((s) => {
    const target = s.editor.id === siteId ? s.editor : s.sites.find((x) => x.id === siteId)
    if (!target) return {} // deleted
    const ev = target.evaluation
    if (ev.state === 'evaluating' && ev.requestId !== requestId) return {} // superseded
    return update(s, siteId, (x) => ({ ...x, evaluation: { state: 'assessed', key, assessment, transit, pointData } }))
  }),
  applyError: (siteId, requestId, key, message) => set((s) => {
    const target = s.editor.id === siteId ? s.editor : s.sites.find((x) => x.id === siteId)
    if (!target || (target.evaluation.state === 'evaluating' && target.evaluation.requestId !== requestId)) return {}
    return update(s, siteId, (x) => ({ ...x, evaluation: { state: 'error', key, message } }))
  }),
  resetConfirmed: () => set({ editor: newSite(), sites: [], hover: null }),
}))
