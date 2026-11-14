export const AU_KM = 149_597_870.7
export const UNIT_KM = 1000 // 1 scene unit = 1000 km

type V = { x: number; y: number; z: number }

// Astronomy Engine: Z = north pole. Three.js: Y = up.
// (X, Y, Z) -> (X, Z, -Y)
export const toScene = (v: V, scale = AU_KM / UNIT_KM): [number, number, number] =>
  [v.x * scale, v.z * scale, -v.y * scale]