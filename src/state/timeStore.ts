import { create } from 'zustand'
import { loadMissionDefaults } from '../sim'
import * as C from '../time/clock'
import type { ClockConfig, ClockState } from '../time/clock'

// Scene clock store (step 16). Pure transitions live in time/clock.ts; this store supplies the clocks:
// Date.now() for "now" (captured once at load, and again at a confirmed reset) and performance.now() (monotonic) for
// elapsed playback time. The scene reads useTime.getState().t inside useFrame; one driver (time/clockDriver.ts) ticks.
// The clock never writes mission inputs or starts a calculation.

/** Clock configuration from the bundled defaults (interaction.*): the single source of speeds and range rules. */
export const CLOCK_CONFIG: ClockConfig = (() => {
  const i = loadMissionDefaults().interaction
  return {
    playbackSpeeds: i.playbackSpeeds, defaultPlaybackSpeed: i.defaultPlaybackSpeed, autoplayOnLoad: i.autoplayOnLoad,
    defaultRangeYears: i.defaultRangeYears, clearStartBeforeNowMonths: i.clearStartBeforeNowMonths,
    clearEndAfterNowYears: i.clearEndAfterNowYears, clearResetsPlaybackSpeed: i.clearResetsPlaybackSpeed,
  }
})()

const wall = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

type TimeStore = ClockState & {
  /** Advance a playing clock (called by the single frame driver). */
  tick: () => void
  play: () => void
  pause: () => void
  togglePlay: () => void
  setRate: (rate: number) => void
  /** Manual jump; pauses; refused while locked; outside the range only the crossed end is extended. */
  seek: (t: number) => void
  /** Jump to the system now (paused); refused while locked; extends only the crossed end. */
  jumpToNow: () => void
  /** Kept for existing callers: same as seek. */
  setT: (t: number) => void
  setRange: (min: number, max: number) => void
  /** Accepted calculation (registered with the task scheduler): pause, jump to the Landing Time, lock. */
  lockToLanding: (landingMs: number, requestId: string) => void
  /** Time side of a confirmed Clear / Reset input. */
  resetTimeConfirmed: () => void
}

const pick = (s: TimeStore): ClockState => ({ t: s.t, min: s.min, max: s.max, playing: s.playing, rate: s.rate, anchor: s.anchor, lock: s.lock, notice: s.notice })

export const useTime = create<TimeStore>((set, get) => {
  const apply = (f: (s: ClockState) => ClockState) => {
    const before = pick(get())
    const after = f(before)
    if (after !== before) set(after)
  }
  return {
    ...C.initialClock(Date.now(), wall(), CLOCK_CONFIG),
    tick: () => apply((s) => C.advance(s, wall())),
    play: () => apply((s) => C.play(s, wall())),
    pause: () => apply((s) => C.pause(s, wall())),
    togglePlay: () => apply((s) => (s.playing ? C.pause(s, wall()) : C.play(s, wall()))),
    setRate: (rate) => apply((s) => C.setRate(s, rate, wall(), CLOCK_CONFIG)),
    seek: (t) => apply((s) => C.seek(s, t, CLOCK_CONFIG)),
    setT: (t) => apply((s) => C.seek(s, t, CLOCK_CONFIG)),
    jumpToNow: () => apply((s) => C.jumpToNow(s, Date.now(), CLOCK_CONFIG)),
    setRange: (min, max) => apply((s) => C.setRange(s, min, max, wall())),
    lockToLanding: (landingMs, requestId) => apply((s) => C.lockToLanding(s, landingMs, requestId)),
    resetTimeConfirmed: () => apply((s) => C.resetTimeConfirmed(s, Date.now(), wall(), CLOCK_CONFIG)),
  }
})
