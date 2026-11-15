export const AU_KM = 149_597_870.7
export const UNIT_KM = 1000 // 1 scene unit = 1000 km

type V = { x: number; y: number; z: number }

// Astronomy Engine: Z = north pole. Three.js: Y = up.
// (X, Y, Z) -> (X, Z, -Y)
export const toScene = (v: V, scale = AU_KM / UNIT_KM): [number, number, number] =>
  [v.x * scale, v.z * scale, -v.y * scale]

// Moon-local frame: lon 0 -> +X, east -> -Z, north -> +Y
export const latLonToVec3 = (latDeg: number, lonDeg: number, r = 1): [number, number, number] => {
  const lat = (latDeg * Math.PI) / 180
  const lon = (lonDeg * Math.PI) / 180
  return [r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), -r * Math.cos(lat) * Math.sin(lon)]
}

export const vec3ToLatLon = (x: number, y: number, z: number): [number, number] => {
  const r = Math.hypot(x, y, z)
  return [(Math.asin(y / r) * 180) / Math.PI, (Math.atan2(-z, x) * 180) / Math.PI]
}