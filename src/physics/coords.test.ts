import { describe, expect, it } from 'vitest'
import { toScene } from './coords'

describe('toScene', () => {
  it('maps the north pole axis (Z) to scene up (Y)', () => {
    expect(toScene({ x: 0, y: 0, z: 1 }, 1)).toEqual([0, 1, -0])
  })
  it('keeps X as X', () => {
    expect(toScene({ x: 1, y: 0, z: 0 }, 1)).toEqual([1, 0, -0])
  })
})