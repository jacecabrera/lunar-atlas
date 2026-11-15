// Assessment mode and search settings are part of a task's identity: switching them makes the shown results out of date at once,
// and an assessment made under one mode is never current under another.
import { describe, expect, it } from 'vitest'
import { taskFingerprint, CURRENT_MODEL_VERSIONS } from '../sim/task'
import type { TaskState, TaskResult } from '../sim/task'
import { defaultAdvancedSettings } from '../sim/defaults'
import { assessSite } from '../sim/assessment'
import { currentAssessment, confirmCheck } from './customSitesModel'
import type { CustomSite } from './customSitesModel'
import { customSiteKey } from './taskScheduler'
import { useMission } from './missionStore'

const input = { landingTimeMs: Date.UTC(2027, 0, 10, 6), durationMs: 3 * 86_400_000, launchSite: { lat: 28.5, lon: -80.6 } }
const base = defaultAdvancedSettings()
const fp = (settings: typeof base, versions = CURRENT_MODEL_VERSIONS) => taskFingerprint({ input, settings, siteIds: ['a'], versions })
const pass = { status: 'pass' as const, reasons: [] }
const eligible = (id: string) => assessSite(id, { terrain: pass, power: pass, communication: pass, dataCompleteness: pass })

describe('task identity includes the mode, the policy and the search configuration', () => {
  it('differs for every setting and version that can change a result', () => {
    const a = fp(base)
    expect(fp({ ...base, assessmentMode: base.assessmentMode === 'relaxed' ? 'strict' : 'relaxed' })).not.toBe(a)
    expect(fp({ ...base, search: { ...base.search, coarseStepDeg: base.search.coarseStepDeg + 1 } })).not.toBe(a)
    expect(fp({ ...base, search: { ...base.search, maxFullEvaluations: base.search.maxFullEvaluations - 1 } })).not.toBe(a)
    expect(fp({ ...base, search: { ...base.search, enabled: !base.search.enabled } })).not.toBe(a)
    expect(fp({ ...base, regionalSlopeLimitDeg: base.regionalSlopeLimitDeg + 0.5 })).not.toBe(a)
    expect(fp(base, { ...CURRENT_MODEL_VERSIONS, data: { ...CURRENT_MODEL_VERSIONS.data, globalTerrain: 'global-dem-v2' } })).not.toBe(a)
    expect(fp(base, { ...CURRENT_MODEL_VERSIONS, models: { ...CURRENT_MODEL_VERSIONS.models, regional: 'regional-v2' } })).not.toBe(a)
    expect(fp(structuredClone(base))).toBe(a) // the same content gives the same identity
  })
  it('the default mode is the regional estimate and strict is selectable', () => {
    expect(base.assessmentMode).toBe('relaxed'); expect(base.search.coarseStepDeg).toBe(5); expect(base.search.refineStepDeg).toBe(1)
  })
})

describe('switching the mode on the home page', () => {
  const doneTask = (mode: 'strict' | 'relaxed'): TaskState => ({
    status: 'done', request: { requestId: 'r', fingerprint: 'FP-' + mode, versions: CURRENT_MODEL_VERSIONS, startedAtMs: 0 },
    result: { requestId: 'r', fingerprint: 'FP-' + mode, versions: CURRENT_MODEL_VERSIONS, completedAtMs: 1, sites: [], recommendations: [], outcome: 'no-eligible-sites', mode } as TaskResult,
  })
  it('makes a finished result stale at once (nothing recalculates by itself) and keeps the typed inputs', () => {
    useMission.setState({ task: doneTask('relaxed'), draft: { landingTimeMs: input.landingTimeMs, durationDays: 3, launchLat: 28.5, launchLon: -80.6 } })
    useMission.getState().setSettings({ ...useMission.getState().settings, assessmentMode: 'strict' })
    expect(useMission.getState().task.status).toBe('stale')
    expect(useMission.getState().draft.durationDays).toBe(3)
    useMission.getState().resetSettings() // restores the preset (relaxed); also stale, still not recalculated
    expect(useMission.getState().settings.assessmentMode).toBe('relaxed')
  })
  it('an assessment made for the other mode (another task fingerprint) is not current, so it cannot be confirmed or drawn', () => {
    const site: CustomSite = { id: 'custom-1', name: 'X', lat: 10, lon: 20, evaluation: { state: 'assessed', key: customSiteKey('FP-relaxed', 10, 20), assessment: eligible('custom-1') } }
    expect(currentAssessment(site, doneTask('relaxed'))).not.toBeNull()
    expect(currentAssessment(site, doneTask('strict'))).toBeNull()
    expect(confirmCheck(site, doneTask('strict'), 0, 9).ok).toBe(false)
    expect(confirmCheck(site, doneTask('relaxed'), 0, 9).ok).toBe(true)
  })
})
