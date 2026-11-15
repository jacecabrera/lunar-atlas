import { describe, expect, it } from 'vitest'
import { summarizeConditions, notEvaluated, assessSite } from './assessment'
import type { ConditionResult, SiteConditions } from './assessment'

const pass: ConditionResult = { status: 'pass', reasons: [] }
const fail = (code: string): ConditionResult => ({ status: 'fail', reasons: [{ code, message: code }] })
const unknown = (code: string): ConditionResult => ({ status: 'unknown', reasons: [{ code, message: code }] })
const error = (code: string): ConditionResult => ({ status: 'error', reasons: [{ code, message: code }] })

const allPass: SiteConditions = { terrain: pass, power: pass, communication: pass, dataCompleteness: pass }
const conditions = (patch: Partial<SiteConditions>): SiteConditions => ({ ...allPass, ...patch })

describe('summarizeConditions', () => {
  it('allows landing and recommendation only when every condition passes', () => {
    const s = summarizeConditions(allPass)
    expect(s.landingAllowed).toBe(true)
    expect(s.eligibleForRecommendation).toBe(true)
    expect(s.reasons).toEqual([])
  })

  it('a proven physical failure gives false', () => {
    const s = summarizeConditions(conditions({ communication: fail('no-direct-earth-visibility') }))
    expect(s.landingAllowed).toBe(false)
    expect(s.eligibleForRecommendation).toBe(false)
    expect(s.failed).toEqual(['communication'])
  })

  it('keeps a known failure when other conditions are unknown or errored, and keeps every reason', () => {
    const s = summarizeConditions({
      terrain: unknown('dem-too-coarse'),
      power: fail('reserve-reached-while-discharging'),
      communication: error('service-error'),
      dataCompleteness: fail('footprint-data-missing'),
    })
    expect(s.landingAllowed).toBe(false)
    expect(s.failed).toEqual(['power'])
    expect(s.undetermined).toEqual(['terrain', 'dataCompleteness'])
    expect(s.errored).toEqual(['communication'])
    expect(s.reasons.map((r) => `${r.condition}:${r.status}:${r.code}`)).toEqual([
      'terrain:unknown:dem-too-coarse',
      'power:fail:reserve-reached-while-discharging',
      'communication:error:service-error',
      'dataCompleteness:fail:footprint-data-missing',
    ])
  })

  it('unknown never yields eligibility, even with everything else passing', () => {
    const s = summarizeConditions(conditions({ terrain: unknown('dem-too-coarse') }))
    expect(s.landingAllowed).toBeNull()
    expect(s.eligibleForRecommendation).toBe(false)
  })

  it('a service error is not a physical failure', () => {
    const s = summarizeConditions(conditions({ terrain: error('terrain-fetch-failed') }))
    expect(s.landingAllowed).toBeNull()
    expect(s.failed).toEqual([])
    expect(s.errored).toEqual(['terrain'])
  })

  it('insufficient data (dataCompleteness fail) is not a proven hazard', () => {
    const s = summarizeConditions(conditions({ dataCompleteness: fail('dem-too-coarse') }))
    expect(s.landingAllowed).toBeNull()
    expect(s.failed).toEqual([])
    expect(s.undetermined).toEqual(['dataCompleteness'])
    expect(s.eligibleForRecommendation).toBe(false)
  })

  it('treats not-evaluated conditions as unknown', () => {
    const s = summarizeConditions({
      terrain: notEvaluated(), power: notEvaluated(), communication: notEvaluated(), dataCompleteness: notEvaluated(),
    })
    expect(s.landingAllowed).toBeNull()
    expect(s.eligibleForRecommendation).toBe(false)
    expect(s.reasons.every((r) => r.code === 'not-evaluated')).toBe(true)
  })

  it('records a placeholder reason when a non-pass result forgot to give one', () => {
    const s = summarizeConditions(conditions({ power: { status: 'unknown', reasons: [] } }))
    expect(s.reasons).toEqual([
      { condition: 'power', status: 'unknown', code: 'no-reason-given', message: 'No reason was recorded' },
    ])
  })
})

describe('assessSite', () => {
  it('derives the summary from the conditions', () => {
    const a = assessSite('apollo-11', conditions({ terrain: unknown('dem-too-coarse') }))
    expect(a.siteId).toBe('apollo-11')
    expect(a.summary.landingAllowed).toBeNull()
  })
})
