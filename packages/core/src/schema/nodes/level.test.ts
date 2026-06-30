import { describe, expect, test } from 'bun:test'
import { LevelNode } from './level'

describe('LevelNode children', () => {
  test('accepts every MEP child ID and rejects invalid IDs', () => {
    const children = [
      'duct-segment_test',
      'duct-fitting_test',
      'duct-terminal_test',
      'hvac-equipment_test',
      'lineset_test',
      'liquid-line_test',
      'pipe-segment_test',
      'pipe-fitting_test',
      'pipe-trap_test',
    ] as const

    expect(LevelNode.parse({ children: [...children] }).children).toEqual([...children])
    expect(LevelNode.safeParse({ children: ['invalid_test'] }).success).toBe(false)
  })
})
