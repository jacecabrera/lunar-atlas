// Time scales. Importing this module installs a Delta T function in Astronomy Engine; every physics module that calls
// the library imports it first.
//
// Astronomy Engine treats a JavaScript Date (UTC) as Universal Time and derives Terrestrial Time as TT = UT + DeltaT(UT).
// Its default DeltaT is the Espenak-Meeus polynomial, which extrapolates to about 75 s in 2026 and 82 s in 2036. For a
// past UTC input the relation is known exactly instead: TT = UTC + 32.184 s + (TAI - UTC), where TAI - UTC is the
// tabulated offset (not a count of leap seconds; it starts at 10 s in 1972). TT - UTC = 69.184 s since 2017-01-01.
// Using the polynomial put the Moon up to ~17 km away from DE441 by 2036 (the Moon moves about 1 km/s relative to the
// Earth); step 06 replaced it.
//
// Initialisation: SetDeltaTFunction changes module-level state of the library. It runs when this module is first
// imported; moonFrame, ephemeris and earthFrame import it before anything else, so every path through src/sim or
// src/physics installs it. Code that imports astronomy-engine alone keeps the polynomial (see timeScaleInit tests).
// POSIX milliseconds cannot represent the inserted second 23:59:60 itself; the offset changes at 00:00:00 UTC.
//
// What remains approximate:
// - Earth rotation still uses UTC in place of UT1 (|UT1 - UTC| < 0.9 s): up to ~0.4 km at the equator.
// - TAI - UTC after the table's expiry is unknown. The last offset is held constant, as JPL Horizons does for future
//   UTC ("UT~"). This is an assumption, not knowledge: a future leap second would shift TT by 1 s (about 1 km of lunar
//   motion). Future Earth orientation (UT1 - UTC, polar motion) is not modelled at all.
// - Before 1972 there is no leap-second UTC; the library's polynomial is kept there.
import { DeltaT_EspenakMeeus, SetDeltaTFunction } from 'astronomy-engine'

/** TT - TAI, seconds (exact by definition). */
export const TT_MINUS_TAI_S = 32.184

/**
 * IERS Leap_Second.dat, "Updated through IERS Bulletin 72 issued in July 2026", file expires 28 June 2027:
 * [MJD (UTC) from which the value applies, TAI - UTC in seconds].
 * Source: https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat (SRC-IERS-LEAP-SECONDS in sources.md).
 */
export const LEAP_SECONDS: ReadonlyArray<readonly [number, number]> = [
  [41317, 10], [41499, 11], [41683, 12], [42048, 13], [42413, 14], [42778, 15], [43144, 16], [43509, 17],
  [43874, 18], [44239, 19], [44786, 20], [45151, 21], [45516, 22], [46247, 23], [47161, 24], [47892, 25],
  [48257, 26], [48804, 27], [49169, 28], [49534, 29], [50083, 30], [50630, 31], [51179, 32], [53736, 33],
  [54832, 34], [56109, 35], [57204, 36], [57754, 37],
]
/** The table is only known to be complete up to this UTC date (its expiry). Later values are an assumption. */
export const LEAP_SECONDS_VALID_UNTIL_UTC = '2027-06-28'

const MJD_UNIX_EPOCH = 40587
const MJD_J2000 = 51544.5 // Astronomy Engine counts days from 2000-01-01T12:00

/** TAI - UTC in seconds at a UTC instant, or null before 1972 (no leap-second UTC). */
export function taiMinusUtcSeconds(utcMs: number): number | null {
  const mjd = utcMs / 86_400_000 + MJD_UNIX_EPOCH
  if (!(mjd >= LEAP_SECONDS[0][0])) return null
  let value = LEAP_SECONDS[0][1]
  for (const [start, v] of LEAP_SECONDS) if (mjd >= start) value = v
  return value
}

/** TT - UTC in seconds at a UTC instant (falls back to the library's Delta T model before 1972). */
export function ttMinusUtcSeconds(utcMs: number): number {
  const tai = taiMinusUtcSeconds(utcMs)
  return tai === null ? DeltaT_EspenakMeeus(utcMs / 86_400_000 + MJD_UNIX_EPOCH - MJD_J2000) : TT_MINUS_TAI_S + tai
}

/** Delta T for Astronomy Engine. `ut` is days since J2000 in the library's UT, which is our UTC. */
function deltaTFromLeapSeconds(ut: number): number {
  return ttMinusUtcSeconds((ut + MJD_J2000 - MJD_UNIX_EPOCH) * 86_400_000)
}

SetDeltaTFunction(deltaTFromLeapSeconds)

/** Label for result identities. */
export const TIME_SCALE_MODEL = 'tt=utc+32.184s+(tai-utc)(iers-bulletin-c-72; held after 2027-06-28); ut1=utc'
