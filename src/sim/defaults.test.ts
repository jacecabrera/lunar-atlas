import { describe, expect, it } from 'vitest'
import defaultsJson from '../data/lunar-mission-defaults-v0.1.json'
import {
  parseMissionDefaults, loadMissionDefaults, defaultAdvancedSettings,
} from './defaults'
import { validateAdvancedSettings, reserveEnergyWh, totalPanelAreaM2, normalizeWeights } from './mission'
import type { AdvancedSettings } from './mission'
import { loadCandidateCatalog } from './catalog'
import { CURRENT_MODEL_VERSIONS, withDataVersions, taskFingerprint } from './task'
import { LEGACY_PLACEHOLDER_POWER_CONFIG } from './power'
import { useMission } from '../state/missionStore'


// Path-based edits on a deep copy of the JSON, so the negative tests need no `any`.
type Node = Record<string, unknown>
const walk = (root: unknown, path: string[]): Node => path.reduce<Node>((n, k) => n[k] as Node, root as Node)
const put = (root: unknown, path: string, value: unknown) => { const p = path.split('/'); walk(root, p.slice(0, -1))[p.at(-1)!] = value }
const get = (root: unknown, path: string) => { const p = path.split('/'); return walk(root, p.slice(0, -1))[p.at(-1)!] }
const del = (root: unknown, path: string) => { const p = path.split('/'); delete walk(root, p.slice(0, -1))[p.at(-1)!] }
const errorsOf = (mutate: (d: unknown) => void) => {
  const d = structuredClone(defaultsJson)
  mutate(d)
  const r = parseMissionDefaults(d)
  return r.ok ? [] : r.errors
}

describe('mission defaults', () => {
  const d = loadMissionDefaults()
  const s = d.settings

  it('carries the confirmed ILN-inspired values in the contract units (W, Wh, fractions, km/s)', () => {
    expect(d.presetId).toBe('iln-inspired-solar-lander')
    expect(s.device.pvEfficiency).toBe(0.3)
    expect(s.device.panels.map((p) => [p.id, p.azimuthDeg, p.tiltDeg])).toEqual([['east', 90, 90], ['west', 270, 90]])
    expect(s.device.pvOutputLimitW).toBe(100)
    expect([s.device.baseLoadW, s.device.commLoadW]).toEqual([23, 5])
    expect(s.device.busEfficiency).toBe(0.9)
    expect([s.device.batteryCapacityWh, s.device.initialEnergyWh]).toEqual([12000, 12000])
    expect([s.device.chargeEfficiency, s.device.dischargeEfficiency]).toEqual([0.95, 0.95])
    expect([s.device.chargeLimitW, s.device.dischargeLimitW]).toEqual([100, 100])
    expect([s.transitSpeedKmPerS, s.footprintDiameterM, s.slopeLimitDeg, s.obstacleLimitM, s.earthMinElevationDeg]).toEqual([1.5, 3, 5, 0.3, 0])
    expect(s.weights).toEqual({ sunlight: 0.5, earth: 0.3, terrain: 0.2 })
    expect(s.limits).toEqual({ maxRecommendations: 3, maxCustomSites: 9 })
    expect(s.model).toEqual({ irradianceWm2: 1361, referenceDistanceAu: 1, lossFactor: 1 })
  })

  it('computes the panel area and the reserve from single sources', () => {
    expect(totalPanelAreaM2(s.device)).toBeCloseTo(0.5832, 12)
    expect(reserveEnergyWh(s.device)).toBeCloseTo(2400, 9)
    // Editing the capacity moves the derived reserve with it; there is no second stored value to contradict.
    expect(reserveEnergyWh({ ...s.device, batteryCapacityWh: 20000 })).toBeCloseTo(4000, 9)
    expect('reserveWh' in s.device).toBe(false)
  })

  it('reproduces the dimensional check of the reference: 356.9 h and 293.1 h without sunlight', () => {
    const usable = s.device.batteryCapacityWh - reserveEnergyWh(s.device)
    const hours = (loadW: number) => (usable * s.device.dischargeEfficiency) / (loadW / s.device.busEfficiency)
    expect(hours(s.device.baseLoadW)).toBeCloseTo(356.9, 1)
    expect(hours(s.device.baseLoadW + s.device.commLoadW)).toBeCloseTo(293.1, 1)
  })

  it('keeps the four efficiencies as separate values with separate parameter keys', () => {
    const keys = Object.keys(d.parameters).filter((k) => k.endsWith('Efficiency'))
    expect(keys.sort()).toEqual(['device.busEfficiency', 'device.chargeEfficiency', 'device.dischargeEfficiency', 'device.pvEfficiency'])
  })

  it('does not hold any main input, mission duration, minimum score or relay', () => {
    expect(defaultsJson.mainInputs.landingTime.initialValue).toBeNull()
    expect(defaultsJson.mainInputs.durationDays.initialValue).toBeNull()
    expect(defaultsJson.mainInputs.launchSite.initialValue).toBeNull()
    expect(Object.keys(d.parameters).some((k) => /duration|stay|landingTime|launchSite|minimumScore|relay/i.test(k))).toBe(false)
  })

  it('labels each value as source value, derived or project assumption, and keeps the 23 W / 5 W split', () => {
    const p = (k: string) => d.parameters[k]
    expect(p('device.pvEfficiency').kind).toBe('source-value')
    expect(p('device.panelTotalAreaM2').kind).toBe('derived')
    expect(p('device.baseLoadW').kind).toBe('source-value')
    expect(p('device.baseLoadContinuous').kind).toBe('project-assumption')
    expect(p('device.commLoadW').kind).toBe('source-value')
    expect(p('device.commAlwaysOnWhenEarthVisible').kind).toBe('project-assumption')
    expect(p('device.pvOutputLimitW').kind).toBe('project-assumption')
    expect(p('device.pvArrayNominalW').kind).toBe('source-value')
    expect(p('mission.transitSpeedKmPerS').kind).toBe('project-assumption')
    expect(p('terrain.slopeLimitDeg').kind).toBe('project-assumption')
    expect(s.provenance['device.reserveWh']?.kind).toBe('derived')
    // Step 11 re-read the ILN report (Figure 8.3/8.4, Section 5.4.4/5.4.5): values checked there say so, values from
    // documents that were never opened keep 'not-verified'.
    expect(p('device.pvEfficiency').verification).toBe('read-original')
    expect(p('model.solarIrradianceWm2').verification).toBe('not-verified')
    expect(p('device.batteryCapacityWh').verification).toBe('not-applicable')
  })

  it('has provenance for every parameter, and every project assumption names its ASM ID', () => {
    for (const [k, v] of Object.entries(d.parameters)) {
      expect(s.provenance[k]).toBeDefined()
      if (v.kind === 'project-assumption') expect(v.assumptionIds.length).toBeGreaterThan(0)
      if (v.kind === 'source-value' || v.kind === 'derived') expect(v.sourceIds.length).toBeGreaterThan(0)
    }
  })

  it('exposes the interaction defaults without implementing them', () => {
    expect(d.interaction).toEqual({
      timeBase: 'UTC', autoplayOnLoad: true, defaultPlaybackSpeed: 1, playbackSpeeds: [1, 1.25, 1.5, 2, 3, 5],
      defaultRangeYears: 1, clearStartBeforeNowMonths: 1, clearEndAfterNowYears: 1, clearResetsPlaybackSpeed: true,
    })
  })

  it('passes the settings validator and returns independent copies', () => {
    expect(validateAdvancedSettings(s)).toEqual([])
    const a = defaultAdvancedSettings()
    a.device.batteryCapacityWh = 1
    a.weights.sunlight = 9
    expect(defaultAdvancedSettings().device.batteryCapacityWh).toBe(12000)
    expect(loadMissionDefaults().settings.weights.sunlight).toBe(0.5)
  })
})

describe('mission defaults validation', () => {
  it('rejects a pre-filled main input', () => {
    expect(errorsOf((d) => put(d, 'mainInputs/durationDays/initialValue', 14)).join()).toMatch(/durationDays/)
    expect(errorsOf((d) => put(d, 'mainInputs/landingTime/initialValue', 0)).join()).toMatch(/landingTime/)
  })
  it('rejects unknown parameters, so a minimum score or relay cannot slip in', () => {
    expect(errorsOf((d) => put(d, 'parameters/scoring.minimumScore', get(d, 'parameters/scoring.weightTerrain'))).join()).toMatch(/unknown parameter/)
    expect(errorsOf((d) => put(d, 'parameters/communication.relayEnabled', get(d, 'parameters/device.baseLoadContinuous'))).join()).toMatch(/unknown parameter/)
    expect(errorsOf((d) => put(d, 'extra', 1)).join()).toMatch(/unknown top-level key/)
  })
  it('rejects missing, mistyped and wrong-unit parameters', () => {
    expect(errorsOf((d) => del(d, 'parameters/device.busEfficiency')).join()).toMatch(/busEfficiency is missing/)
    expect(errorsOf((d) => put(d, 'parameters/device.baseLoadW/value', '23')).join()).toMatch(/invalid value/)
    expect(errorsOf((d) => put(d, 'parameters/device.baseLoadW/value', Number.NaN)).join()).toMatch(/invalid value/)
    expect(errorsOf((d) => put(d, 'parameters/device.baseLoadW/unit', 'kW')).join()).toMatch(/unit "W"/)
    expect(errorsOf((d) => put(d, 'parameters/device.batteryCapacityWh/unit', 'kWh')).join()).toMatch(/unit "Wh"/)
  })
  it('rejects values without a source, and assumptions without a definition', () => {
    expect(errorsOf((d) => put(d, 'parameters/device.pvEfficiency/sourceIds', [])).join()).toMatch(/needs a source ID/)
    expect(errorsOf((d) => put(d, 'parameters/device.busEfficiency/assumptionIds', [])).join()).toMatch(/ASM-/)
    expect(errorsOf((d) => put(d, 'parameters/device.pvEfficiency/sourceIds', ['iln'])).join()).toMatch(/sourceIds/)
    expect(errorsOf((d) => put(d, 'parameters/device.pvEfficiency/verification', 'maybe')).join()).toMatch(/verification/)
  })
  it('rejects an inconsistent panel area, azimuth count or playback speed list', () => {
    expect(errorsOf((d) => put(d, 'parameters/device.panelTotalAreaM2/value', 0.6)).join()).toMatch(/panelTotalAreaM2/)
    expect(errorsOf((d) => put(d, 'parameters/device.panelAzimuthsDeg/value', [90])).join()).toMatch(/one azimuth per panel/)
    expect(errorsOf((d) => put(d, 'parameters/interaction.playbackSpeeds/value', [1, 3, 2])).join()).toMatch(/increasing/)
    expect(errorsOf((d) => put(d, 'parameters/interaction.defaultPlaybackSpeed/value', 4)).join()).toMatch(/one of the playback speeds/)
    expect(errorsOf((d) => put(d, 'parameters/interaction.timeBase/value', 'local')).join()).toMatch(/UTC/)
  })
  it('rejects physically invalid settings through the shared validator', () => {
    expect(errorsOf((d) => put(d, 'parameters/device.pvEfficiency/value', 1.2)).join()).toMatch(/Solar efficiency/)
    expect(errorsOf((d) => put(d, 'parameters/device.initialEnergyWh/value', 13000)).join()).toMatch(/exceed battery capacity/)
    expect(errorsOf((d) => put(d, 'parameters/device.reserveFraction/value', 1)).join()).toMatch(/Reserve fraction/)
    expect(errorsOf((d) => put(d, 'parameters/device.dischargeLimitW/value', 0)).join()).toMatch(/discharge power limit/)
    expect(errorsOf((d) => {
      for (const k of ['scoring.weightSunlight', 'scoring.weightEarthVisibility', 'scoring.weightTerrain']) put(d, `parameters/${k}/value`, 0)
    }).join()).toMatch(/weights/)
    expect(errorsOf((d) => put(d, 'parameters/scoring.weightTerrain/value', -0.2)).join()).toMatch(/weights/)
  })
  it('rejects a wrong schema, an unsupported version and non-objects', () => {
    expect(parseMissionDefaults(undefined).ok).toBe(false)
    expect(errorsOf((d) => put(d, 'schemaVersion', 9)).join()).toMatch(/schemaVersion/)
  })
})

describe('settings validator and weights', () => {
  const base = () => structuredClone(loadMissionDefaults().settings) as AdvancedSettings
  it('normalises weights, and refuses all-zero, negative and non-finite ones', () => {
    expect(normalizeWeights({ sunlight: 5, earth: 3, terrain: 2 })).toEqual({ sunlight: 0.5, earth: 0.3, terrain: 0.2 })
    expect(normalizeWeights({ sunlight: 0, earth: 0, terrain: 0 })).toBeNull()
    expect(normalizeWeights({ sunlight: -1, earth: 1, terrain: 1 })).toBeNull()
    expect(normalizeWeights({ sunlight: Number.NaN, earth: 1, terrain: 1 })).toBeNull()
    expect(normalizeWeights({ sunlight: 0, earth: 1, terrain: 0 })).toEqual({ sunlight: 0, earth: 1, terrain: 0 })
  })
  it('flags invalid efficiencies, capacities and limits', () => {
    for (const mutate of [
      (s: AdvancedSettings) => { s.device.busEfficiency = 0 },
      (s: AdvancedSettings) => { s.device.chargeEfficiency = 1.01 },
      (s: AdvancedSettings) => { s.device.batteryCapacityWh = Number.NaN },
      (s: AdvancedSettings) => { s.device.initialEnergyWh = 100; s.device.reserveFraction = 0.2 },
      (s: AdvancedSettings) => { s.device.panels = [] },
      (s: AdvancedSettings) => { s.device.panels[0].tiltDeg = 120 },
      (s: AdvancedSettings) => { s.transitSpeedKmPerS = 0 },
      (s: AdvancedSettings) => { s.limits.maxCustomSites = 2.5 },
    ]) {
      const s = base()
      mutate(s)
      expect(validateAdvancedSettings(s).length).toBeGreaterThan(0)
    }
  })
})

describe('integration with the task store and result identity', () => {
  it('initialises and resets settings from the same preset, with empty main inputs', () => {
    const st = useMission.getState()
    expect(st.draft).toEqual({ landingTimeMs: null, durationDays: null, launchLat: null, launchLon: null })
    expect(st.settings).toEqual(loadMissionDefaults().settings)
    st.setSettings({ ...st.settings, transitSpeedKmPerS: 2 })
    expect(useMission.getState().settings.transitSpeedKmPerS).toBe(2)
    useMission.getState().resetSettings()
    expect(useMission.getState().settings).toEqual(loadMissionDefaults().settings)
  })

  it('keeps the legacy power model isolated from the new preset', () => {
    expect(useMission.getState().legacyPower).toEqual(LEGACY_PLACEHOLDER_POWER_CONFIG)
    expect(useMission.getState().legacyPower.maxSolarW).toBe(4000) // not the 100 W of the new device
  })

  it('puts the catalog and preset versions into the result identity without using the clock', () => {
    const catalog = loadCandidateCatalog()
    const defaults = loadMissionDefaults()
    const v1 = withDataVersions(CURRENT_MODEL_VERSIONS, { catalog, defaults })
    const v2 = withDataVersions(CURRENT_MODEL_VERSIONS, { catalog, defaults })
    expect(v1.data.candidates).toBe('historical-reference-sites@v0.1')
    expect(v1.data.settingsPreset).toBe('iln-inspired-solar-lander@v0.1')
    expect(v1).toEqual(v2)
    const input = { landingTimeMs: 0, durationMs: 86_400_000, launchSite: { lat: 0, lon: 0 } }
    const fp = (versions: typeof v1) => taskFingerprint({ input, settings: defaults.settings, siteIds: ['apollo-11'], versions })
    expect(fp(v1)).toBe(fp(v2))
    const bumped = withDataVersions(CURRENT_MODEL_VERSIONS, { catalog: { ...catalog, dataVersion: 'v0.2' }, defaults })
    expect(fp(bumped)).not.toBe(fp(v1))
    // The settings themselves are part of the identity too.
    const edited = { ...defaults.settings, transitSpeedKmPerS: 2 }
    expect(taskFingerprint({ input, settings: edited, siteIds: ['apollo-11'], versions: v1 })).not.toBe(fp(v1))
  })
})
