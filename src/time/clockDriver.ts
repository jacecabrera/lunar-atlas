// The one frame loop that advances the scene clock. Reference-counted, so React StrictMode's double mount or several
// callers never start two loops. Hidden tabs pause requestAnimationFrame; on resume the clock catches up from its
// anchor (time/clock.ts), and a paused or locked clock does not move.
import { useTime } from '../state/timeStore'

let users = 0
let handle: number | null = null

function frame() {
  useTime.getState().tick()
  handle = requestAnimationFrame(frame)
}

export function startClockDriver(): () => void {
  users += 1
  if (handle === null && typeof requestAnimationFrame !== 'undefined') handle = requestAnimationFrame(frame)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    users -= 1
    if (users === 0 && handle !== null) { cancelAnimationFrame(handle); handle = null }
  }
}

export const clockDriverUsers = () => users
