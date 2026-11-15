// Sidebar rules without React: parsing, settings conversion, derived values and status wording.
import { describe, expect, it } from 'vitest'
import { applySettingText, derivedSettings, draftFieldErrors, parseNumberText, parseUtcText, SETTING_GROUPS, settingText, statusView } from './formModel'
import { defaultAdvancedSettings } from '../sim/defaults'
import { validateAdvancedSettings, EMPTY_MISSION_DRAFT } from '../sim/mission'
import type { TaskState, TaskResult } from '../sim/task'

const field = (key: string) => SETTING_GROUPS.flatMap((g) => g.fields).find((f) => f.key === key)!

describe('field parsing', () => {
  it('keeps 0 as a value, empty as not filled, and everything else that is not a finite decimal as invalid', () => {
    expect(parseNumberText('0')).toBe(0)
    expect(parseNumberText('-0.0')).toBe(-0)
    expect(parseNumberText(' 12.5 ')).toBe(12.5)
    expect(parseNumberText('.5')).toBe(0.5)
    expect(parseNumberText('1e3')).toBe(1000)
    expect(parseNumberText('')).toBeNull()
    expect(parseNumberText('   ')).toBeNull()
    for (const bad of ['-', '1,5', 'Infinity', '-Infinity', 'NaN', '0x10', '1e999', 'abc']) expect(Number.isNaN(parseNumberText(bad)), bad).toBe(true)
  })
  it('parses UTC dates strictly with the step 16 parser', () => {
    expect(parseUtcText('2027-03-01 06:00:00')).toBe(Date.UTC(2027, 2, 1, 6))
    expect(parseUtcText('')).toBeNull()
    expect(Number.isNaN(parseUtcText('2027-02-29 00:00:00'))).toBe(true)
    expect(Number.isNaN(parseUtcText('next week'))).toBe(true)
  })
  it('accepts latitude and longitude 0 and names invalid fields', () => {
    expect(draftFieldErrors({ landingTimeMs: Date.UTC(2027, 0, 1), durationDays: 3, launchLat: 0, launchLon: 0 })).toEqual({})
    const e = draftFieldErrors({ landingTimeMs: Number.NaN, durationDays: -1, launchLat: 91, launchLon: Number.NaN })
    expect(e.landingTimeMs).toMatch(/YYYY-MM-DD/)
    expect(e.durationDays).toMatch(/greater than 0/)
    expect(e.launchLat).toMatch(/between -90 and 90/)
    expect(e.launchLon).toMatch(/finite/)
    expect(Object.keys(draftFieldErrors({ ...EMPTY_MISSION_DRAFT }))).toHaveLength(4) // all required
  })
})

describe('More settings', () => {
  const s = defaultAdvancedSettings()
  it('shows fractions as percent and stores percent as fractions, without binary noise', () => {
    expect(settingText(field('device.pvEfficiency'), s)).toBe('30')
    expect(settingText(field('device.chargeEfficiency'), s)).toBe('95')
    expect(settingText(field('device.reserveFraction'), s)).toBe('20')
    const t = applySettingText(field('device.busEfficiency'), s, '85')
    expect(t.device.busEfficiency).toBeCloseTo(0.85, 12)
    expect(settingText(field('device.busEfficiency'), t)).toBe('85')
  })
  it('keeps one PV efficiency, separate bus and battery efficiencies, and derived values read-only', () => {
    const keys = SETTING_GROUPS.flatMap((g) => g.fields.map((f) => f.key))
    expect(keys.filter((k) => /pvEfficiency/.test(k))).toHaveLength(1)
    expect(keys).toEqual(expect.arrayContaining(['device.busEfficiency', 'device.chargeEfficiency', 'device.dischargeEfficiency']))
    expect(keys).not.toContain('device.reserveWh')
    expect(keys).not.toContain('device.panelTotalAreaM2')
    const d = derivedSettings(s)
    expect(d.reserveWh).toBe(2400)
    expect(d.totalPanelAreaM2).toBeCloseTo(0.5832, 12)
    const t = applySettingText(field('device.panelTiltDeg'), s, '45')
    expect(t.device.panels.map((p) => p.tiltDeg)).toEqual([45, 45])
  })
  it('writes invalid or empty text as NaN so validation blocks it, never a silent default', () => {
    const t = applySettingText(field('device.batteryCapacityWh'), s, '')
    expect(Number.isNaN(t.device.batteryCapacityWh)).toBe(true)
    expect(validateAdvancedSettings(t).join(' ')).toMatch(/Battery capacity/)
  })
  it('normalises weights, and all-zero weights are invalid (not reset to defaults)', () => {
    expect(derivedSettings(s).normalizedWeights).toEqual({ sunlight: 0.5, earth: 0.3, terrain: 0.2 })
    const doubled = ['scoring.weightSunlight', 'scoring.weightEarthVisibility', 'scoring.weightTerrain'].reduce((x, k) => applySettingText(field(k), x, String(field(k).get(x) * 2)), s)
    expect(derivedSettings(doubled).normalizedWeights).toEqual({ sunlight: 0.5, earth: 0.3, terrain: 0.2 })
    const zero = ['scoring.weightSunlight', 'scoring.weightEarthVisibility', 'scoring.weightTerrain'].reduce((x, k) => applySettingText(field(k), x, '0'), s)
    expect(derivedSettings(zero).normalizedWeights).toBeNull()
    expect(validateAdvancedSettings(zero).join(' ')).toMatch(/weights/)
  })
})

describe('status wording', () => {
  const request = { requestId: 'r1', fingerprint: 'f', versions: {} as TaskResult['versions'], startedAtMs: 0 }
  const result = (outcome: TaskResult['outcome'], n: number): TaskResult => ({
    requestId: 'r1', fingerprint: 'f', versions: request.versions, completedAtMs: 1, sites: [], outcome,
    recommendations: Array.from({ length: n }, (_, i) => ({ siteId: `s${i}`, rank: i + 1, score: 50, parts: { sunlight: 0.5, earth: 0.5, terrain: 0.5 } })),
    evaluation: { ranked: [], weights: null, model: 'm', excluded: { physicalFail: [{ siteId: 'change-4', reasons: [] }], insufficientData: Array.from({ length: 11 }, (_, i) => ({ siteId: `x${i}`, reasons: [] })), serviceError: [], notScored: [], beyondLimit: [], customNotRecommended: [] } },
  })
  it('separates empty, invalid, running, done, stale, error and normal zero recommendations', () => {
    expect(statusView('empty', { status: 'idle' }, null, null).kind).toBe('empty')
    expect(statusView('invalid', { status: 'idle' }, null, null).kind).toBe('invalid')
    expect(statusView('valid', { status: 'idle' }, null, ['Landing Time is required']).lines).toEqual(['Landing Time is required'])
    const running: TaskState = { status: 'running', request }
    expect(statusView('valid', running, { requestId: 'r1', done: 4, total: 12, phase: 'evaluate', siteId: 'apollo-14' }, null).lines[0]).toBe('Evaluating sites: 4 of 12 (apollo-14)')
    expect(statusView('valid', running, { requestId: 'old', done: 9, total: 12, phase: 'evaluate', siteId: null }, null).lines[0]).toBe('Preparing data') // not another request's progress
    const zero = statusView('valid', { status: 'done', request, result: result('no-eligible-sites', 0) }, null, null)
    expect(zero.kind).toBe('no-eligible')
    expect(zero.lines.join(' ')).toMatch(/finished normally/)
    expect(zero.lines).toEqual(expect.arrayContaining(['Shown not to meet a condition: 1', 'Not enough data to decide: 11', 'Service errors: 0']))
    expect(statusView('valid', { status: 'done', request, result: result('recommendations', 2) }, null, null).title).toBe('2 recommended site(s)')
    expect(statusView('valid', { status: 'stale', request, result: result('no-eligible-sites', 0) }, null, null).kind).toBe('stale')
    const err = statusView('valid', { status: 'error', request, error: { requestId: 'r1', kind: 'internal', message: 'Worker failed' } }, null, null)
    expect(err.kind).toBe('error')
    expect(err.lines.join(' ')).toMatch(/not a finding about the sites/)
  })
})
