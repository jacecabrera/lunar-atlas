// A horizon is the terrain skyline seen from a site: azimuth (deg, clockwise from north)
// -> elevation of the skyline above the flat horizontal plane (deg). Flat sphere = 0.
export type Horizon = (azimuthDeg: number) => number

export const flatHorizon: Horizon = () => 0

// Build a Horizon from evenly spaced samples. profile[i] is the skyline elevation at
// azimuth i * 360 / profile.length. Interpolates linearly and wraps around north.
export function horizonFromProfile(profile: number[]): Horizon {
  const n = profile.length
  if (n < 2) throw new Error('profile needs at least 2 samples')
  return (azimuthDeg) => {
    const a = ((((azimuthDeg % 360) + 360) % 360) / 360) * n
    const i = Math.floor(a) % n
    const f = a - Math.floor(a)
    return profile[i] * (1 - f) + profile[(i + 1) % n] * f
  }
}
