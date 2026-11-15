// A horizon is the terrain skyline seen from a site: azimuth (deg, clockwise from north)
// -> elevation of the skyline above the flat horizontal plane (deg). Flat sphere = 0.
export type Horizon = (azimuthDeg: number) => number

export const flatHorizon: Horizon = () => 0

// Build a Horizon from evenly spaced samples covering the full circle. samples[i] is the skyline elevation at
// azimuth startAzimuthDeg + i * stepDeg. Interpolates linearly and wraps around. The sample count is not fixed:
// any step works as long as count * step = 360 deg.
export function horizonFromSamples(samples: number[], startAzimuthDeg = 0, stepDeg = 360 / samples.length): Horizon {
  const n = samples.length
  if (n < 2) throw new Error('profile needs at least 2 samples')
  if (!(stepDeg > 0) || Math.abs(n * stepDeg - 360) > 1e-6) {
    throw new Error(`samples must cover 360 deg: ${n} x ${stepDeg} deg`)
  }
  return (azimuthDeg) => {
    const rel = ((((azimuthDeg - startAzimuthDeg) % 360) + 360) % 360) / stepDeg
    const i = Math.floor(rel) % n
    const f = rel - Math.floor(rel)
    return samples[i] * (1 - f) + samples[(i + 1) % n] * f
  }
}

// Build a Horizon from evenly spaced samples. profile[i] is the skyline elevation at
// azimuth i * 360 / profile.length. Interpolates linearly and wraps around north.
export function horizonFromProfile(profile: number[]): Horizon {
  return horizonFromSamples(profile)
}
