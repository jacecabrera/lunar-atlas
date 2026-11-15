// Background Worker of the details page: one next-set query per message, in order. Cancellation is by request ID on the
// page side (a reply to an outdated request is dropped there), so a slow query never blocks the page.
import { computeNext } from './nextCompute'
import type { NextReply, NextRequest } from './nextEventModel'

const post = (m: NextReply) => (self as unknown as { postMessage: (m: NextReply) => void }).postMessage(m)

self.onmessage = (ev: MessageEvent<NextRequest>) => {
  const req = ev.data
  try { post({ type: 'next-result', requestId: req.requestId, result: computeNext(req) }) }
  catch (e) { post({ type: 'next-error', requestId: req.requestId, message: e instanceof Error ? e.message : String(e) }) }
}
