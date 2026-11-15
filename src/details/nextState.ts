// Per-(point, target) state of next-set queries with stale-reply dropping (step 22). Pure, so the rules are testable.
import type { NextSet } from '../sim/events'

export type NextEntry =
  | { status: 'running'; requestId: string; queryMs: number }
  | { status: 'done'; requestId: string; queryMs: number; result: NextSet }
  | { status: 'error'; requestId: string; queryMs: number; message: string }
export type NextState = Record<string, NextEntry>

/** A new request for a key replaces whatever was there: an older reply can no longer land. */
export function issue(s: NextState, key: string, requestId: string, queryMs: number): NextState {
  return { ...s, [key]: { status: 'running', requestId, queryMs } }
}

/** Needs a query: nothing yet, a different selected time, or an earlier error. A running or finished query for this time is kept. */
export function needsQuery(s: NextState, key: string, queryMs: number): boolean {
  const e = s[key]
  return !e || e.queryMs !== queryMs || e.status === 'error'
}

/** Accept a reply only when it belongs to the current request of some key; any other reply is dropped (state unchanged). */
export function receive(s: NextState, reply: { requestId: string; result?: NextSet; message?: string }): NextState {
  const key = Object.keys(s).find((k) => s[k].requestId === reply.requestId)
  if (!key || s[key].status !== 'running') return s
  const q = s[key].queryMs
  return { ...s, [key]: reply.result ? { status: 'done', requestId: reply.requestId, queryMs: q, result: reply.result } : { status: 'error', requestId: reply.requestId, queryMs: q, message: reply.message ?? 'The query failed' } }
}

/** Worker failure: every running query becomes an error (nothing stays "running" forever). */
export function failRunning(s: NextState, message: string): NextState {
  const out: NextState = {}
  for (const [k, e] of Object.entries(s)) out[k] = e.status === 'running' ? { status: 'error', requestId: e.requestId, queryMs: e.queryMs, message } : e
  return out
}
