// Pure helpers behind the sidebar (step 18): field parsing, More settings descriptors and the task status view.
// No React here, so the rules are unit-tested; the components only wire them to the stores.
import { parseUtcInput } from '../time/clock'
import type { AdvancedSettings, MissionDraft, TaskState, FieldError } from '../sim'
import { normalizeWeights, reserveEnergyWh, totalPanelAreaM2, validateMissionDraft } from '../sim'
import type { TaskProgress } from '../state/taskScheduler'

/** Text -> number for a field: '' -> null (not filled), a finite decimal -> number (0 included), anything else -> NaN. */
export function parseNumberText(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number.NaN // rejects 'Infinity', 'NaN', '1,5', '0x10'
  const v = Number(t)
  return Number.isFinite(v) ? v : Number.NaN
}

/** Text -> UTC ms: '' -> null, a valid UTC date-time -> ms, anything else -> NaN (shown as an invalid date). */
export function parseUtcText(text: string): number | null {
  if (text.trim() === '') return null
  return parseUtcInput(text) ?? Number.NaN
}

/** Field messages for the three main inputs; a non-empty unparsable date gets its own wording. */
export function draftFieldErrors(draft: MissionDraft): Partial<Record<keyof MissionDraft, string>> {
  const v = validateMissionDraft(draft)
  const out: Partial<Record<keyof MissionDraft, string>> = {}
  if (!v.ok) for (const e of v.errors as FieldError[]) out[e.field] = e.message
  if (Number.isNaN(draft.landingTimeMs)) out.landingTimeMs = 'Enter Landing Time as YYYY-MM-DD HH:MM:SS (UTC)'
  return out
}

// ─── More settings ─────────────────────────────────────────────────────────

export type SettingField = {
  key: string
  label: string
  unit: string
  /** 'percent': shown as 0..100, stored as a fraction. */
  scale: 'percent' | 'plain'
  help?: string
  get: (s: AdvancedSettings) => number
  set: (s: AdvancedSettings, v: number) => AdvancedSettings
}

const dev = (k: keyof AdvancedSettings['device']) => ({
  get: (s: AdvancedSettings) => s.device[k] as number,
  set: (s: AdvancedSettings, v: number) => ({ ...s, device: { ...s.device, [k]: v } }),
})

/** Only parameters the calculation supports. Derived values (reserve Wh, total panel area) are shown, not edited. */
export const SETTING_GROUPS: Array<{ title: string; fields: SettingField[] }> = [
  { title: 'Solar panels', fields: [
    { key: 'device.pvEfficiency', label: 'Solar efficiency', unit: '%', scale: 'percent', help: 'Photovoltaic conversion efficiency (the only PV efficiency input).', ...dev('pvEfficiency') },
    { key: 'device.panelTiltDeg', label: 'Panel tilt (both panels)', unit: 'deg', scale: 'plain', help: 'Up from the horizontal plane; 90 = vertical. Project setting.',
      get: (s) => s.device.panels[0]?.tiltDeg ?? Number.NaN, set: (s, v) => ({ ...s, device: { ...s.device, panels: s.device.panels.map((p) => ({ ...p, tiltDeg: v })) } }) },
    { key: 'device.panelAreaM2', label: 'Area of each panel', unit: 'm²', scale: 'plain', help: 'One east-facing and one west-facing panel.',
      get: (s) => s.device.panels[0]?.areaM2 ?? Number.NaN, set: (s, v) => ({ ...s, device: { ...s.device, panels: s.device.panels.map((p) => ({ ...p, areaM2: v })) } }) },
    { key: 'device.pvOutputLimitW', label: 'Array output limit', unit: 'W', scale: 'plain', help: 'Cap on the whole array output (project choice).', ...dev('pvOutputLimitW') },
  ] },
  { title: 'Loads', fields: [
    { key: 'device.baseLoadW', label: 'Base load', unit: 'W', scale: 'plain', help: 'At the device input, for the whole mission.', ...dev('baseLoadW') },
    { key: 'device.commLoadW', label: 'Communication load', unit: 'W', scale: 'plain', help: 'Added during every geometric Earth-visibility interval.', ...dev('commLoadW') },
    { key: 'device.busEfficiency', label: 'Energy use efficiency (bus to device)', unit: '%', scale: 'percent', ...dev('busEfficiency') },
  ] },
  { title: 'Battery', fields: [
    { key: 'device.batteryCapacityWh', label: 'Battery capacity', unit: 'Wh', scale: 'plain', ...dev('batteryCapacityWh') },
    { key: 'device.initialEnergyWh', label: 'Initial stored energy', unit: 'Wh', scale: 'plain', help: 'At the internal storage terminal.', ...dev('initialEnergyWh') },
    { key: 'device.reserveFraction', label: 'Minimum reserve', unit: '% of capacity', scale: 'percent', ...dev('reserveFraction') },
    { key: 'device.chargeEfficiency', label: 'Battery charge efficiency', unit: '%', scale: 'percent', ...dev('chargeEfficiency') },
    { key: 'device.dischargeEfficiency', label: 'Battery discharge efficiency', unit: '%', scale: 'percent', ...dev('dischargeEfficiency') },
    { key: 'device.chargeLimitW', label: 'Charge power limit (bus side)', unit: 'W', scale: 'plain', ...dev('chargeLimitW') },
    { key: 'device.dischargeLimitW', label: 'Discharge power limit (bus side)', unit: 'W', scale: 'plain', ...dev('dischargeLimitW') },
  ] },
  { title: 'Transit and communication', fields: [
    { key: 'mission.transitSpeedKmPerS', label: 'Effective transit speed', unit: 'km/s', scale: 'plain', help: 'For the simplified distance / speed estimate only.', get: (s) => s.transitSpeedKmPerS, set: (s, v) => ({ ...s, transitSpeedKmPerS: v }) },
    { key: 'communication.earthMinElevationDeg', label: 'Minimum Earth elevation', unit: 'deg', scale: 'plain', help: 'Earth disc centre must be above max(terrain horizon, this).', get: (s) => s.earthMinElevationDeg, set: (s, v) => ({ ...s, earthMinElevationDeg: v }) },
  ] },
  { title: 'Regional estimate (used when the assessment mode is Regional estimate)', fields: [
    { key: 'terrain.regionalSlopeLimitDeg', label: 'Regional slope limit', unit: 'deg', scale: 'plain', help: 'Slope over about 3.8 km of the 1.9 km global product; says nothing about a 3 m footprint.', get: (s) => s.regionalSlopeLimitDeg, set: (s, v) => ({ ...s, regionalSlopeLimitDeg: v }) },
  ] },
  { title: 'Whole-Moon search (Regional estimate only, when no catalogue site qualifies)', fields: [
    { key: 'search.coarseStepDeg', label: 'Coarse grid spacing', unit: 'deg', scale: 'plain', help: 'Starting point: 5 deg.', get: (s) => s.search.coarseStepDeg, set: (s, v) => ({ ...s, search: { ...s.search, coarseStepDeg: v } }) },
    { key: 'search.refineStepDeg', label: 'Refinement spacing', unit: 'deg', scale: 'plain', help: 'Around the best regions. Starting point: 1 deg.', get: (s) => s.search.refineStepDeg, set: (s, v) => ({ ...s, search: { ...s.search, refineStepDeg: v } }) },
    { key: 'search.maxFullEvaluations', label: 'Search depth (most full evaluations)', unit: 'count', scale: 'plain', help: 'A search that reaches it is partial and says so.', get: (s) => s.search.maxFullEvaluations, set: (s, v) => ({ ...s, search: { ...s.search, maxFullEvaluations: v } }) },
  ] },
  { title: 'Score weights', fields: [
    { key: 'scoring.weightSunlight', label: 'Sunlight weight', unit: '', scale: 'plain', get: (s) => s.weights.sunlight, set: (s, v) => ({ ...s, weights: { ...s.weights, sunlight: v } }) },
    { key: 'scoring.weightEarthVisibility', label: 'Earth visibility weight', unit: '', scale: 'plain', get: (s) => s.weights.earth, set: (s, v) => ({ ...s, weights: { ...s.weights, earth: v } }) },
    { key: 'scoring.weightTerrain', label: 'Terrain weight', unit: '', scale: 'plain', get: (s) => s.weights.terrain, set: (s, v) => ({ ...s, weights: { ...s.weights, terrain: v } }) },
  ] },
]

/** Settings value -> text in the field's display unit (percent fields x 100, rounded to remove binary noise). */
export function settingText(f: SettingField, s: AdvancedSettings): string {
  const v = f.get(s)
  if (!Number.isFinite(v)) return ''
  return String(f.scale === 'percent' ? Number((v * 100).toPrecision(12)) : v)
}

/** Field text -> new settings (percent fields / 100). Unparsable or empty text is written as NaN so validation blocks it. */
export function applySettingText(f: SettingField, s: AdvancedSettings, text: string): AdvancedSettings {
  const n = parseNumberText(text)
  const v = n === null || Number.isNaN(n) ? Number.NaN : f.scale === 'percent' ? n / 100 : n
  return f.set(s, v)
}

export function derivedSettings(s: AdvancedSettings) {
  const w = normalizeWeights(s.weights)
  return {
    reserveWh: Number.isFinite(reserveEnergyWh(s.device)) ? reserveEnergyWh(s.device) : null,
    totalPanelAreaM2: Number.isFinite(totalPanelAreaM2(s.device)) ? totalPanelAreaM2(s.device) : null,
    normalizedWeights: w,
  }
}

// ─── Status ────────────────────────────────────────────────────────────────

export type StatusView = { kind: 'empty' | 'invalid' | 'running' | 'done' | 'no-eligible' | 'stale' | 'error' | 'ready'; title: string; lines: string[] }

const PHASES: Record<string, string> = {
  terrain: 'Loading terrain', evaluate: 'Evaluating sites', rank: 'Ranking', transit: 'Estimating transit times',
  'search-terrain': 'Loading global terrain for the whole-Moon search', 'search-screen': 'Whole-Moon search: screening the grid', 'search-evaluate': 'Whole-Moon search: evaluating points', 'search-refine': 'Whole-Moon search: refining the best regions',
}

/** One readable status from the input status and the task state; never "unsafe" for missing data or errors. */
export function statusView(inputStatus: 'empty' | 'invalid' | 'valid', task: TaskState, progress: TaskProgress | null, rejected: string[] | null): StatusView {
  if (task.status === 'running') {
    const p = progress && progress.requestId === task.request.requestId ? progress : null
    return { kind: 'running', title: 'Calculating…', lines: [p ? `${PHASES[p.phase] ?? p.phase}: ${p.done} of ${p.total}${p.siteId ? ` (${p.siteId})` : ''}` : 'Preparing data'] }
  }
  if (task.status === 'error') return { kind: 'error', title: 'Calculation failed', lines: [task.error.message, 'This is a service or computation error, not a finding about the sites.'] }
  if (task.status === 'stale') return { kind: 'stale', title: 'Results are out of date', lines: ['The inputs or settings changed after the last calculation. Press Calculate to update.'] }
  if (task.status === 'done') {
    const ex = task.result.evaluation?.excluded
    const counts = ex ? [`Shown not to meet a condition: ${ex.physicalFail.length}`, `Not enough data to decide: ${ex.insufficientData.length}`, `Service errors: ${ex.serviceError.length}`] : []
    const est = task.result.mode === 'relaxed'
    const search = task.result.search
    const searchLine = search ? [search.results.length ? `Whole-Moon search (${search.status}): ${search.results.length} best evaluated point(s) listed below.` : `Whole-Moon search (${search.status}): ${search.message}`] : []
    if (task.result.outcome === 'no-eligible-sites') {
      return { kind: 'no-eligible', title: est ? 'No catalogue site qualifies (regional estimate)' : 'No eligible recommendation', lines: [est ? 'The calculation finished normally; no catalogue site passes every necessary condition in the regional estimate.' : 'The calculation finished normally; no candidate passes every necessary condition under the current model and data.', ...searchLine, ...counts] }
    }
    return { kind: 'done', title: est ? `${task.result.recommendations.length} estimated recommendation(s)` : `${task.result.recommendations.length} recommended site(s)`, lines: counts }
  }
  if (rejected && rejected.length) return { kind: 'invalid', title: 'Cannot calculate yet', lines: rejected }
  if (inputStatus === 'empty') return { kind: 'empty', title: 'Enter the mission inputs', lines: ['Landing Time, Duration of journey and Launch site are required.'] }
  if (inputStatus === 'invalid') return { kind: 'invalid', title: 'Some inputs are invalid', lines: ['Correct the highlighted fields.'] }
  return { kind: 'ready', title: 'Ready to calculate', lines: [] }
}
