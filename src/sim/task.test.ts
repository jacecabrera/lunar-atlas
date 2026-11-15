import { describe, expect, it } from 'vitest'
import {
  taskFingerprint, createRequestId, startTask, completeTask, failTask, markStaleIfChanged,
  CURRENT_MODEL_VERSIONS, IDLE_TASK,
} from './task'
import type { FingerprintInput, TaskRequest, TaskResult } from './task'
import { LEGACY_PLACEHOLDER_POWER_CONFIG } from './power'

const input = { landingTimeMs: Date.UTC(2027, 0, 1), durationMs: 14 * 86_400_000, launchSite: { lat: 28.5, lon: -80.6 } }
const fp = (patch: Partial<FingerprintInput> = {}) =>
  taskFingerprint({
    input,
    settings: { legacyPower: { ...LEGACY_PLACEHOLDER_POWER_CONFIG } },
    siteIds: ['a', 'b'],
    versions: CURRENT_MODEL_VERSIONS,
    ...patch,
  })

const request = (id: string, fingerprint = fp()): TaskRequest => ({
  requestId: id, fingerprint, versions: CURRENT_MODEL_VERSIONS, startedAtMs: 0,
})
const result = (req: TaskRequest): TaskResult => ({
  requestId: req.requestId,
  fingerprint: req.fingerprint,
  versions: req.versions,
  completedAtMs: 1,
  sites: [],
  recommendations: [],
  outcome: 'no-eligible-sites',
})

describe('taskFingerprint', () => {
  it('ignores object key order but not values', () => {
    const reordered = taskFingerprint({
      versions: CURRENT_MODEL_VERSIONS,
      siteIds: ['a', 'b'],
      settings: { legacyPower: { ...LEGACY_PLACEHOLDER_POWER_CONFIG } },
      input: { launchSite: { lon: -80.6, lat: 28.5 }, durationMs: input.durationMs, landingTimeMs: input.landingTimeMs },
    })
    expect(reordered).toBe(fp())
    expect(fp({ input: { ...input, durationMs: input.durationMs + 1 } })).not.toBe(fp())
    expect(fp({ siteIds: ['b', 'a'] })).not.toBe(fp())
    expect(fp({ versions: { ...CURRENT_MODEL_VERSIONS, contract: 99 } })).not.toBe(fp())
  })

  it('refuses values that are not plain finite data', () => {
    expect(() => fp({ input: { ...input, durationMs: Number.NaN } })).toThrow(/finite/)
  })
})

describe('task lifecycle', () => {
  it('gives the same inputs different request IDs', () => {
    expect(createRequestId(0)).not.toBe(createRequestId(0))
  })

  it('accepts the result of the running request; zero recommendations is a normal completion', () => {
    const req = request('r1')
    const done = completeTask(startTask(req), result(req))
    expect(done.status).toBe('done')
    expect(done.status === 'done' && done.result.outcome).toBe('no-eligible-sites')
  })

  it('discards a late result from an earlier request, even with the same fingerprint', () => {
    const first = request('r1')
    const second = request('r2') // identical inputs, new run
    const state = startTask(second)
    expect(completeTask(state, result(first))).toBe(state)
    expect(failTask(state, { requestId: 'r1', kind: 'service', message: 'late' })).toBe(state)
    expect(completeTask(IDLE_TASK, result(first))).toBe(IDLE_TASK)
  })

  it('keeps service errors separate from completed results', () => {
    const req = request('r1')
    const s = failTask(startTask(req), { requestId: 'r1', kind: 'service', message: 'Terrain service unavailable' })
    expect(s.status).toBe('error')
  })

  it('marks a finished result stale when the inputs change, and keeps it when they do not', () => {
    const req = request('r1')
    const done = completeTask(startTask(req), result(req))
    expect(markStaleIfChanged(done, fp())).toBe(done)
    const stale = markStaleIfChanged(done, fp({ siteIds: ['a'] }))
    expect(stale.status).toBe('stale')
    expect(stale.status === 'stale' && stale.result.requestId).toBe('r1')
    expect(markStaleIfChanged(done, null).status).toBe('stale') // inputs became invalid or empty
  })
})
