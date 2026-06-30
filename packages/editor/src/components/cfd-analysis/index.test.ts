import { describe, expect, test } from 'bun:test'
import { fieldView, planeView } from '.'

const grid = {
  shape: [2, 2, 1] as [number, number, number],
  origin: [0.5, 1, 0.25] as [number, number, number],
  spacing: [1, 2, 0.5] as [number, number, number],
  occupiedPlaneZ: 1.5,
}

describe('CFD result conversion', () => {
  test('maps backend x-z-y fields into editor x-y-z points', () => {
    const result = fieldView(new Float32Array([1, 2, 3, 4]).buffer, grid, 3)
    expect(result.positions).toEqual([
      [0.5, 3.25, 1],
      [0.5, 3.25, 3],
      [1.5, 3.25, 1],
      [1.5, 3.25, 3],
    ])
    expect(result.speed).toEqual([1, 2, 3, 4])
  })

  test('maps occupied-plane values at world height', () => {
    const result = planeView(
      [
        [1, 2],
        [3, 4],
      ],
      grid,
      3,
    )
    expect(result.positions[3]).toEqual([1.5, 4.5, 3])
    expect(result.speed).toEqual([1, 2, 3, 4])
  })
})
