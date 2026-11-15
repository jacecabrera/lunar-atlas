// Units and time bases shared by the simulation contracts.
//
// Public contract units:
//   absolute time   UTC milliseconds since the Unix epoch (field suffix `Ms`, e.g. `landingTimeMs`, `tMs`)
//   relative time   milliseconds from the mission start (field suffix `OffsetMs`)
//   durations       milliseconds (field suffix `DurationMs`/`Ms`); the UI shows Earth days (24 h)
//   power           W
//   energy          Wh, measured at the battery's internal storage terminal
//   integration     hours (energy Wh = power W x hours)
//   distance        km; angles in degrees, latitude north positive, longitude east positive
//   efficiencies    fractions 0..1 (the UI may show percent)
//
// Conversions live here so that no module silently mixes kW/kWh with W/Wh or days with milliseconds.

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60_000
export const MS_PER_HOUR = 3_600_000
/** One Earth day of 24 h. "Duration of journey" is entered in these units. */
export const MS_PER_DAY = 86_400_000

export const kwToW = (kw: number) => kw * 1000
export const wToKw = (w: number) => w / 1000
export const kwhToWh = (kwh: number) => kwh * 1000
export const whToKwh = (wh: number) => wh / 1000

export const daysToMs = (days: number) => days * MS_PER_DAY
export const msToDays = (ms: number) => ms / MS_PER_DAY
export const hoursToMs = (hours: number) => hours * MS_PER_HOUR
export const msToHours = (ms: number) => ms / MS_PER_HOUR

/** Valid range of a JavaScript Date, in ms. Values outside it cannot represent a UTC instant. */
export const MAX_DATE_MS = 8.64e15
