// Scene clock (step 16): pure state transitions; the store (state/timeStore.ts) supplies the wall clocks.
//
// Time advances from an anchor: simMs = anchor.simMs + (wallMs - anchor.wallMs) x rate, with wallMs from a monotonic
// clock (performance.now). Pausing, resuming, changing the rate and jumping all re-anchor, so frame rate never changes
// the result and nothing is accumulated twice. A hidden tab that stops drawing simply catches up from the anchor when
// it resumes (paused or locked clocks do not move). Reaching the range end pauses at the end; no wrap, no extension.
//
// Engineering choices (recorded in the step 16 record): a manual jump or slider drag leaves the clock paused; a range
// edit that excludes the cursor pauses and moves it to the nearest edge with a notice; a Landing Time outside the
// range extends only the needed end to include it exactly. A lock (accepted calculation) blocks every time change
// until the confirmed reset; the playback rate may still be chosen but does not move a locked clock.
//
// The default range (load-time now +/- interaction.defaultRangeYears UTC calendar years, 1 since 2026-11-15) is a
// display choice, not a statement of ephemeris accuracy or of the event-search validity domain.
import { addUtcMonths, addUtcYears } from './utcCalendar'

export type ClockConfig = {
  playbackSpeeds: readonly number[]
  defaultPlaybackSpeed: number
  autoplayOnLoad: boolean
  defaultRangeYears: number
  clearStartBeforeNowMonths: number
  clearEndAfterNowYears: number
  clearResetsPlaybackSpeed: boolean
}

export type ClockState = {
  t: number
  min: number
  max: number
  playing: boolean
  rate: number
  /** Set while playing. */
  anchor: { wallMs: number; simMs: number } | null
  /** Set by an accepted calculation; only the confirmed reset clears it. */
  lock: { landingMs: number; requestId: string } | null
  /** Last user-facing note (English UI text), e.g. why an action was refused. */
  notice: string | null
}

/** Largest |t| accepted (the calculation layer's date range, sim/units MAX_DATE_MS). */
export const CLOCK_MAX_ABS_MS = 8.64e15

const valid = (ms: number) => Number.isFinite(ms) && Math.abs(ms) <= CLOCK_MAX_ABS_MS

export function initialClock(nowMs: number, wallMs: number, c: ClockConfig): ClockState {
  const t = nowMs // one captured "now" for the cursor and both ends
  return {
    t, min: addUtcYears(t, -c.defaultRangeYears), max: addUtcYears(t, c.defaultRangeYears),
    playing: c.autoplayOnLoad, rate: c.defaultPlaybackSpeed, anchor: c.autoplayOnLoad ? { wallMs, simMs: t } : null, lock: null, notice: null,
  }
}

/** Advance a playing clock to wallMs. */
export function advance(s: ClockState, wallMs: number): ClockState {
  if (!s.playing || !s.anchor || s.lock) return s
  const sim = s.anchor.simMs + (wallMs - s.anchor.wallMs) * s.rate
  if (sim >= s.max) return { ...s, t: s.max, playing: false, anchor: null, notice: 'Reached the end of the time range; playback paused' }
  return sim === s.t ? s : { ...s, t: sim }
}

const locked = (s: ClockState): ClockState => ({ ...s, notice: 'Time is locked to the calculated Landing Time' })

export function play(s: ClockState, wallMs: number): ClockState {
  if (s.lock) return locked(s)
  if (s.t >= s.max) return { ...s, playing: false, anchor: null, notice: 'At the end of the time range; move the cursor or the end to play' }
  return { ...s, playing: true, anchor: { wallMs, simMs: s.t }, notice: null }
}

export function pause(s: ClockState, wallMs: number): ClockState {
  const a = advance(s, wallMs)
  return { ...a, playing: false, anchor: null }
}

export function setRate(s: ClockState, rate: number, wallMs: number, c: ClockConfig): ClockState {
  if (!c.playbackSpeeds.includes(rate)) return { ...s, notice: `Unsupported speed ${rate}x` }
  const a = advance(s, wallMs)
  return { ...a, rate, anchor: a.playing ? { wallMs, simMs: a.t } : null }
}

/**
 * Manual jump (slider, keyboard, typed time). Leaves the clock paused. Refused while locked (the lock is only lifted by a
 * confirmed Clear). With a config, an unlocked jump outside the range extends only the end it crossed: a time before the start
 * becomes the start exactly; a time after the end becomes `clearEndAfterNowYears` calendar years past it, so that Play can
 * advance afterwards (an end equal to the cursor would refuse to play). Without a config an outside time is refused as before.
 */
export function seek(s: ClockState, t: number, c?: ClockConfig): ClockState {
  if (s.lock) return locked(s)
  if (!valid(t)) return { ...s, notice: 'Invalid time' }
  if (t >= s.min && t <= s.max) return { ...s, t, playing: false, anchor: null, notice: null }
  if (!c) return { ...s, notice: 'Time is outside the range; change the range first' }
  const max = t > s.max ? addUtcYears(t, c.clearEndAfterNowYears) : s.max
  const min = t < s.min ? t : s.min
  if (!valid(max)) return { ...s, notice: 'Invalid time' }
  return { ...s, t, min, max, playing: false, anchor: null, notice: t < s.min ? 'The range start was moved to the time you went to' : 'The range end was extended past the time you went to' }
}

/**
 * Jump to the system "now". Same refusals as seek (locked: refused, never an unlock). Outside the range only the crossed end
 * moves, by the Clear rule (start: now - clearStartBeforeNowMonths, end: now + clearEndAfterNowYears), so Play works afterwards.
 * The clock is left paused; Play resumes from now.
 */
export function jumpToNow(s: ClockState, nowMs: number, c: ClockConfig): ClockState {
  if (s.lock) return locked(s)
  if (!valid(nowMs)) return { ...s, notice: 'Invalid time' }
  let { min, max } = s
  if (nowMs < min) min = addUtcMonths(nowMs, -c.clearStartBeforeNowMonths)
  else if (nowMs > max) max = addUtcYears(nowMs, c.clearEndAfterNowYears)
  const moved = min !== s.min || max !== s.max
  return { ...s, t: nowMs, min, max, playing: false, anchor: null, notice: moved ? 'The range was extended to include now' : null }
}

/** Edit the range. A locked Landing Time must stay inside it. A cursor outside it is paused and moved to the nearest edge. */
export function setRange(s: ClockState, min: number, max: number, wallMs: number): ClockState {
  if (!valid(min) || !valid(max)) return { ...s, notice: 'Range bounds must be valid UTC times' }
  if (!(min < max)) return { ...s, notice: 'Range start must be before its end' }
  if (s.lock && (s.lock.landingMs < min || s.lock.landingMs > max)) return { ...s, notice: 'The range must include the locked Landing Time' }
  const a = advance(s, wallMs)
  if (a.t < min || a.t > max) {
    const t = a.t < min ? min : max
    return { ...a, min, max, t, playing: false, anchor: null, notice: 'The cursor was outside the new range; it was moved to the nearest edge and paused' }
  }
  return { ...a, min, max, anchor: a.playing ? { wallMs, simMs: a.t } : null, notice: null }
}

/** Accepted calculation: pause -> jump to the Landing Time (extending only the needed end) -> lock. */
export function lockToLanding(s: ClockState, landingMs: number, requestId: string): ClockState {
  if (!valid(landingMs)) return { ...s, notice: 'Invalid Landing Time' }
  const min = Math.min(s.min, landingMs), max = Math.max(s.max, landingMs)
  const extended = min !== s.min || max !== s.max
  return { ...s, min, max, t: landingMs, playing: false, anchor: null, lock: { landingMs, requestId }, notice: extended ? 'The range was extended to include the Landing Time' : null }
}

/**
 * Time side of a confirmed Clear / Reset input (step 23 owns the dialog). Uses the system now at confirmation: unlock,
 * default speed, autoplay; now inside the range (ends included): both ends kept; before the start: only the start
 * becomes now - 1 calendar month; after the end: only the end becomes now + 1 calendar year. The default range is
 * not restored.
 */
export function resetTimeConfirmed(s: ClockState, nowMs: number, wallMs: number, c: ClockConfig): ClockState {
  let { min, max } = s
  if (nowMs < min) min = addUtcMonths(nowMs, -c.clearStartBeforeNowMonths)
  else if (nowMs > max) max = addUtcYears(nowMs, c.clearEndAfterNowYears)
  const rate = c.clearResetsPlaybackSpeed ? c.defaultPlaybackSpeed : s.rate
  return { t: nowMs, min, max, playing: true, rate, anchor: { wallMs, simMs: nowMs }, lock: null, notice: null }
}

/** Strict UTC text input, "YYYY-MM-DDTHH:MM:SS" with optional "Z" (a space may replace "T"). No rollover of invalid dates. */
export function parseUtcInput(text: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?Z?\s*$/.exec(text)
  if (!m) return null
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number)
  const out = new Date(0)
  out.setUTCFullYear(y, mo - 1, d)
  out.setUTCHours(h, mi, se, 0)
  if (out.getUTCFullYear() !== y || out.getUTCMonth() !== mo - 1 || out.getUTCDate() !== d || out.getUTCHours() !== h || out.getUTCMinutes() !== mi || out.getUTCSeconds() !== se) return null
  return out.getTime()
}

/** "YYYY-MM-DD HH:MM:SS UTC" for display and as the input's initial text. */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}
