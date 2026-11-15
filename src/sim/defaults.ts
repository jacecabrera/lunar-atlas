// Loader and validator for the mission defaults file (src/data/lunar-mission-defaults-v0.1.json).
//
// The JSON is bundled with the app. Its content is validated at runtime and never trusted through a type
// assertion. Unknown keys are rejected so a setting such as a minimum total score or a relay cannot be added to the
// preset by accident. Every parameter carries a provenance entry whose IDs refer to the register in sources.md.
//
// Loading the file only produces settings. It does not evaluate any site, and the three main task inputs
// (landing time, mission duration, launch site) stay empty.
import defaultsJson from '../data/lunar-mission-defaults-v0.1.json'
import type { AdvancedSettings, PanelSpec } from './mission'
import { validateAdvancedSettings } from './mission'
import type { ParameterProvenance, ProvenanceKind, SourceVerification } from './provenance'

export const DEFAULTS_SCHEMA = 'lunar-navigator.mission-defaults'
export const DEFAULTS_SCHEMA_VERSION = 1

export type ParamValue = number | boolean | string | number[]

/** One entry of the defaults file. */
export type DefaultParameter = {
  value: ParamValue
  unit: string
  kind: ProvenanceKind
  sourceIds: string[]
  assumptionIds: string[]
  verification: SourceVerification
  note: string
}

/** Clock and Clear defaults. Configuration only; the behaviour is implemented in steps 16 and 23. */
export type InteractionDefaults = {
  timeBase: 'UTC'
  autoplayOnLoad: boolean
  defaultPlaybackSpeed: number
  playbackSpeeds: number[]
  defaultRangeYears: number
  clearStartBeforeNowMonths: number
  clearEndAfterNowYears: number
  clearResetsPlaybackSpeed: boolean
}

export type MissionDefaults = {
  presetId: string
  dataVersion: string
  label: string
  settings: AdvancedSettings
  interaction: InteractionDefaults
  /** The raw parameter table, for display of units, notes and sources. */
  parameters: Record<string, DefaultParameter>
}

type Kind = 'number' | 'boolean' | 'string' | 'numbers'
// Every key the file must contain, with its value type and unit. Anything else is rejected.
const SPEC: Record<string, [Kind, string]> = {
  'device.pvEfficiency': ['number', 'fraction'],
  'device.panelCount': ['number', 'count'],
  'device.panelWidthM': ['number', 'm'],
  'device.panelHeightM': ['number', 'm'],
  'device.panelTotalAreaM2': ['number', 'm2'],
  'device.panelAzimuthsDeg': ['numbers', 'deg'],
  'device.panelTiltDeg': ['number', 'deg'],
  'device.pvArrayNominalW': ['number', 'W'],
  'device.pvOutputLimitW': ['number', 'W'],
  'device.baseLoadW': ['number', 'W'],
  'device.baseLoadContinuous': ['boolean', 'boolean'],
  'device.commLoadW': ['number', 'W'],
  'device.commAlwaysOnWhenEarthVisible': ['boolean', 'boolean'],
  'device.busEfficiency': ['number', 'fraction'],
  'device.batteryCapacityWh': ['number', 'Wh'],
  'device.initialEnergyWh': ['number', 'Wh'],
  'device.reserveFraction': ['number', 'fraction'],
  'device.chargeEfficiency': ['number', 'fraction'],
  'device.dischargeEfficiency': ['number', 'fraction'],
  'device.chargeLimitW': ['number', 'W'],
  'device.dischargeLimitW': ['number', 'W'],
  'model.solarIrradianceWm2': ['number', 'W/m2'],
  'model.solarReferenceDistanceAu': ['number', 'AU'],
  'model.lossFactor': ['number', 'fraction'],
  'mission.transitSpeedKmPerS': ['number', 'km/s'],
  'terrain.footprintDiameterM': ['number', 'm'],
  'terrain.slopeLimitDeg': ['number', 'deg'],
  'terrain.obstacleLimitM': ['number', 'm'],
  'terrain.regionalSlopeLimitDeg': ['number', 'deg'],
  'assessment.mode': ['string', 'label'],
  'search.enabled': ['boolean', 'boolean'],
  'search.coarseStepDeg': ['number', 'deg'],
  'search.refineStepDeg': ['number', 'deg'],
  'search.maxFullEvaluations': ['number', 'count'],
  'search.refineSeeds': ['number', 'count'],
  'search.budgetMs': ['number', 'ms'],
  'communication.earthMinElevationDeg': ['number', 'deg'],
  'scoring.weightSunlight': ['number', 'weight'],
  'scoring.weightEarthVisibility': ['number', 'weight'],
  'scoring.weightTerrain': ['number', 'weight'],
  'limits.maxRecommendations': ['number', 'count'],
  'limits.maxCustomSites': ['number', 'count'],
  'interaction.timeBase': ['string', 'label'],
  'interaction.autoplayOnLoad': ['boolean', 'boolean'],
  'interaction.defaultPlaybackSpeed': ['number', 'x'],
  'interaction.playbackSpeeds': ['numbers', 'x'],
  'interaction.defaultRangeYears': ['number', 'calendar years'],
  'interaction.clearStartBeforeNowMonths': ['number', 'calendar months'],
  'interaction.clearEndAfterNowYears': ['number', 'calendar years'],
  'interaction.clearResetsPlaybackSpeed': ['boolean', 'boolean'],
}

const KINDS: ProvenanceKind[] = ['source-value', 'derived', 'project-assumption', 'dataset', 'model', 'unverified']
const VERIFICATIONS: SourceVerification[] = [
  'read-original', 'metadata-only', 'agent-reported', 'not-verified', 'access-failed', 'not-applicable',
]
const TOP_KEYS = ['schema', 'schemaVersion', 'presetId', 'dataVersion', 'label', 'description', 'mainInputs', 'parameters']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const idList = (v: unknown, pattern: RegExp): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && pattern.test(x))

export type DefaultsParse = { ok: true; defaults: MissionDefaults } | { ok: false; errors: string[] }

/** Validate untrusted data and build the typed defaults. Never throws. */
export function parseMissionDefaults(raw: unknown): DefaultsParse {
  const errors: string[] = []
  if (!isObj(raw)) return { ok: false, errors: ['Mission defaults must be an object'] }
  if (raw.schema !== DEFAULTS_SCHEMA) errors.push(`schema must be "${DEFAULTS_SCHEMA}"`)
  if (raw.schemaVersion !== DEFAULTS_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`)
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errors.push(`unknown top-level key "${k}"`)
  for (const k of ['presetId', 'dataVersion', 'label'] as const) {
    if (typeof raw[k] !== 'string' || raw[k] === '') errors.push(`${k} must be a non-empty string`)
  }

  // The three main inputs must stay empty.
  const mi = raw.mainInputs
  if (!isObj(mi)) errors.push('mainInputs is required')
  else {
    for (const k of ['landingTime', 'durationDays', 'launchSite']) {
      const e = mi[k]
      if (!isObj(e) || e.initialValue !== null) errors.push(`mainInputs.${k}.initialValue must be null (main inputs start empty)`)
    }
    for (const k of Object.keys(mi)) if (!['landingTime', 'durationDays', 'launchSite'].includes(k)) errors.push(`unknown main input "${k}"`)
  }

  const params: Record<string, DefaultParameter> = {}
  const table = raw.parameters
  if (!isObj(table)) errors.push('parameters is required')
  else {
    for (const k of Object.keys(table)) if (!(k in SPEC)) errors.push(`unknown parameter "${k}"`)
    for (const [key, [type, unit]] of Object.entries(SPEC)) {
      const e = table[key]
      if (!isObj(e)) { errors.push(`parameter ${key} is missing`); continue }
      const v = e.value
      const okType = type === 'number' ? finite(v) : type === 'boolean' ? typeof v === 'boolean' : type === 'string' ? typeof v === 'string' && v !== '' : Array.isArray(v) && v.length > 0 && v.every(finite)
      if (!okType) errors.push(`parameter ${key} has an invalid value (expected ${type})`)
      if (e.unit !== unit) errors.push(`parameter ${key} must have unit "${unit}"`)
      if (!KINDS.includes(e.kind as ProvenanceKind)) errors.push(`parameter ${key} has an invalid kind`)
      if (!idList(e.sourceIds, /^(SRC|REQ)-.+/)) errors.push(`parameter ${key} sourceIds must be SRC-/REQ- IDs`)
      if (!idList(e.assumptionIds, /^ASM-.+/)) errors.push(`parameter ${key} assumptionIds must be ASM- IDs`)
      if (!VERIFICATIONS.includes(e.verification as SourceVerification)) errors.push(`parameter ${key} has an invalid verification status`)
      if (typeof e.note !== 'string' || e.note === '') errors.push(`parameter ${key} needs a note`)
      const sids = Array.isArray(e.sourceIds) ? e.sourceIds : []
      const aids = Array.isArray(e.assumptionIds) ? e.assumptionIds : []
      // A value must say where it comes from; a project assumption must name its definition.
      if ((e.kind === 'source-value' || e.kind === 'derived') && sids.length === 0) errors.push(`parameter ${key} (${String(e.kind)}) needs a source ID`)
      if (e.kind === 'project-assumption' && aids.length === 0) errors.push(`parameter ${key} is a project assumption and needs an ASM- ID`)
      if (okType) params[key] = e as unknown as DefaultParameter
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const n = (k: string) => params[k].value as number
  const b = (k: string) => params[k].value as boolean
  const list = (k: string) => params[k].value as number[]

  // Cross-checks between related values.
  const count = n('device.panelCount')
  if (!Number.isInteger(count) || count < 1) errors.push('device.panelCount must be a positive whole number')
  const area = count * n('device.panelWidthM') * n('device.panelHeightM')
  if (Math.abs(area - n('device.panelTotalAreaM2')) > 1e-9) errors.push(`device.panelTotalAreaM2 (${n('device.panelTotalAreaM2')}) does not equal panelCount x width x height (${area})`)
  if (list('device.panelAzimuthsDeg').length !== count) errors.push('device.panelAzimuthsDeg must list one azimuth per panel')
  if (params['interaction.timeBase'].value !== 'UTC') errors.push('interaction.timeBase must be "UTC"')
  const speeds = list('interaction.playbackSpeeds')
  if (speeds.some((s) => s <= 0) || speeds.some((s, i) => i > 0 && s <= speeds[i - 1])) errors.push('interaction.playbackSpeeds must be positive and strictly increasing')
  if (!speeds.includes(n('interaction.defaultPlaybackSpeed'))) errors.push('interaction.defaultPlaybackSpeed must be one of the playback speeds')
  for (const k of ['interaction.defaultRangeYears', 'interaction.clearStartBeforeNowMonths', 'interaction.clearEndAfterNowYears']) {
    if (!Number.isInteger(n(k)) || n(k) < 1) errors.push(`${k} must be a positive whole number`)
  }
  if (errors.length > 0) return { ok: false, errors }

  const panels: PanelSpec[] = list('device.panelAzimuthsDeg').map((azimuthDeg, i) => ({
    id: azimuthDeg === 90 ? 'east' : azimuthDeg === 270 ? 'west' : `panel-${i + 1}`,
    areaM2: n('device.panelWidthM') * n('device.panelHeightM'),
    azimuthDeg,
    tiltDeg: n('device.panelTiltDeg'),
  }))
  const provenance: Record<string, ParameterProvenance> = {}
  for (const [k, p] of Object.entries(params)) {
    provenance[k] = { kind: p.kind, sourceIds: p.sourceIds, assumptionIds: p.assumptionIds, verification: p.verification, note: p.note }
  }
  const settings: AdvancedSettings = {
    presetId: raw.presetId as string,
    presetVersion: raw.dataVersion as string,
    device: {
      pvEfficiency: n('device.pvEfficiency'),
      panels,
      pvOutputLimitW: n('device.pvOutputLimitW'),
      baseLoadW: n('device.baseLoadW'),
      commLoadW: n('device.commLoadW'),
      busEfficiency: n('device.busEfficiency'),
      batteryCapacityWh: n('device.batteryCapacityWh'),
      initialEnergyWh: n('device.initialEnergyWh'),
      reserveFraction: n('device.reserveFraction'),
      chargeEfficiency: n('device.chargeEfficiency'),
      dischargeEfficiency: n('device.dischargeEfficiency'),
      chargeLimitW: n('device.chargeLimitW'),
      dischargeLimitW: n('device.dischargeLimitW'),
    },
    operation: { baseLoadContinuous: b('device.baseLoadContinuous'), commAlwaysOnWhenEarthVisible: b('device.commAlwaysOnWhenEarthVisible') },
    model: { irradianceWm2: n('model.solarIrradianceWm2'), referenceDistanceAu: n('model.solarReferenceDistanceAu'), lossFactor: n('model.lossFactor') },
    transitSpeedKmPerS: n('mission.transitSpeedKmPerS'),
    earthMinElevationDeg: n('communication.earthMinElevationDeg'),
    footprintDiameterM: n('terrain.footprintDiameterM'),
    slopeLimitDeg: n('terrain.slopeLimitDeg'),
    obstacleLimitM: n('terrain.obstacleLimitM'),
    regionalSlopeLimitDeg: n('terrain.regionalSlopeLimitDeg'),
    assessmentMode: params['assessment.mode'].value as AdvancedSettings['assessmentMode'],
    search: {
      enabled: b('search.enabled'), coarseStepDeg: n('search.coarseStepDeg'), refineStepDeg: n('search.refineStepDeg'),
      maxFullEvaluations: n('search.maxFullEvaluations'), refineSeeds: n('search.refineSeeds'), budgetMs: n('search.budgetMs'),
    },
    weights: { sunlight: n('scoring.weightSunlight'), earth: n('scoring.weightEarthVisibility'), terrain: n('scoring.weightTerrain') },
    limits: { maxRecommendations: n('limits.maxRecommendations'), maxCustomSites: n('limits.maxCustomSites') },
    provenance: {
      ...provenance,
      'device.reserveWh': {
        kind: 'derived', sourceIds: [], assumptionIds: ['ASM-RESERVE-POLICY'], verification: 'not-applicable',
        note: 'Derived: battery capacity x reserve fraction. Never stored separately.',
      },
    },
  }
  const problems = validateAdvancedSettings(settings)
  if (problems.length > 0) return { ok: false, errors: problems.map((m) => `settings: ${m}`) }
  return {
    ok: true,
    defaults: {
      presetId: settings.presetId,
      dataVersion: settings.presetVersion,
      label: raw.label as string,
      settings,
      interaction: {
        timeBase: 'UTC',
        autoplayOnLoad: b('interaction.autoplayOnLoad'),
        defaultPlaybackSpeed: n('interaction.defaultPlaybackSpeed'),
        playbackSpeeds: speeds,
        defaultRangeYears: n('interaction.defaultRangeYears'),
        clearStartBeforeNowMonths: n('interaction.clearStartBeforeNowMonths'),
        clearEndAfterNowYears: n('interaction.clearEndAfterNowYears'),
        clearResetsPlaybackSpeed: b('interaction.clearResetsPlaybackSpeed'),
      },
      parameters: params,
    },
  }
}

let cached: MissionDefaults | null = null

/** The bundled preset. Throws with every problem listed if the file is invalid (fail fast at start-up). */
export function loadMissionDefaults(): MissionDefaults {
  if (cached) return cached
  const r = parseMissionDefaults(defaultsJson)
  if (!r.ok) throw new Error(`Invalid mission defaults: ${r.errors.join('; ')}`)
  cached = r.defaults
  return cached
}

/**
 * A fresh copy of the default settings, so one caller's edits never leak into the preset or into another caller.
 * Used by the task store for both initialisation and reset.
 */
export function defaultAdvancedSettings(): AdvancedSettings {
  return structuredClone(loadMissionDefaults().settings)
}
