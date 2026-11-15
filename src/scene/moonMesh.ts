import type { Mesh } from 'three'

/** The Moon mesh currently on screen (for picking, step 19). Mesh-local axes: lon 0 = +X, east = -Z, north = +Y. */
export const moonMesh: { current: Mesh | null } = { current: null }
