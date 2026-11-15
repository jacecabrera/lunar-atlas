// UTC calendar arithmetic shared by the timeline (step 16: default range now +/- 10 calendar years) and Clear
// (step 23: start = now - 1 calendar month, end = now + 1 calendar year). One implementation so both follow the
// same rules: UTC fields, time of day kept, and a day that does not exist in the target month (31st, Feb 29)
// clamped to that month's last day. Not fixed 30/365-day offsets.

const daysInUtcMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()

/** Add (or subtract, with a negative n) whole calendar months in UTC. */
export function addUtcMonths(ms: number, months: number): number {
  if (!Number.isFinite(ms) || !Number.isInteger(months)) throw new RangeError('addUtcMonths needs a finite time and an integer month count')
  const d = new Date(ms)
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months
  const year = Math.floor(total / 12)
  const month0 = total - year * 12
  const day = Math.min(d.getUTCDate(), daysInUtcMonth(year, month0))
  const out = new Date(0)
  out.setUTCFullYear(year, month0, day) // setUTCFullYear handles years 0..99, which Date.UTC would map to 1900s
  out.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
  return out.getTime()
}

/** Add (or subtract) whole calendar years in UTC. Feb 29 + 1 year -> Feb 28. */
export function addUtcYears(ms: number, years: number): number {
  if (!Number.isInteger(years)) throw new RangeError('addUtcYears needs an integer year count')
  return addUtcMonths(ms, years * 12)
}
