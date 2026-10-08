import { describe, expect, it } from 'bun:test'
import {
  calculateDraftRate,
  cfdToThree,
  classifyComfort,
  comfortRgb,
  coolToWarmRgb,
  createDefaultVectorField,
  generateSampleGridPoints,
  generateSliceRgbaBuffer,
  getSlicePlaneConfig,
  interpolateVectorField,
  threeToCfd,
  turboRgb,
} from './airflow-math'

describe('Airflow math & conversions', () => {
  it('converts between CFD and Three.js coordinate systems', () => {
    // CFD [8.8, 6.1, 3.2] -> Three [8.8, 3.2, 6.1]
    expect(cfdToThree(8.8, 6.1, 3.2)).toEqual([8.8, 3.2, 6.1])
    expect(threeToCfd(8.8, 3.2, 6.1)).toEqual([8.8, 6.1, 3.2])
  })

  it('calculates ASHRAE 55 draft rate correctly', () => {
    // Velocity below 0.05 m/s should have zero draft rate
    expect(calculateDraftRate(0.04, 24)).toBe(0)
    // Velocity above 0.05 m/s
    const dr = calculateDraftRate(0.2, 22)
    expect(dr).toBeGreaterThan(0)
    expect(dr).toBeLessThanOrEqual(100)
  })

  it('classifies comfort categories according to ASHRAE 55', () => {
    // Stagnant: v < 0.05
    expect(classifyComfort(0.03, 297.15)).toBe('stagnant')
    // Comfort: 0.05 <= v <= 0.20 and 23.0 <= T_c <= 26.0 (296.15 - 299.15 K)
    expect(classifyComfort(0.12, 297.65)).toBe('comfort') // 24.5 C
    // Draft: v > 0.20 or too cold
    expect(classifyComfort(0.35, 297.15)).toBe('draft')
    expect(classifyComfort(0.1, 293.15)).toBe('draft') // 20 C is too cold
  })

  it('provides RGB colormap values', () => {
    const turboMin = turboRgb(0)
    const turboMax = turboRgb(1)
    expect(turboMin.length).toBe(3)
    expect(turboMax.length).toBe(3)

    const coolMin = coolToWarmRgb(0)
    const coolMax = coolToWarmRgb(1)
    expect(coolMin.length).toBe(3)
    expect(coolMax.length).toBe(3)

    expect(comfortRgb('comfort')).toEqual([34, 197, 94])
    expect(comfortRgb('draft')).toEqual([59, 130, 246])
    expect(comfortRgb('stagnant')).toEqual([245, 158, 11])
  })

  it('returns appropriate slice plane configs for X, Y, Z axes', () => {
    const configZ = getSlicePlaneConfig('z', 1.1)
    expect(configZ.position).toEqual([4.4, 1.1, 3.05])
    expect(configZ.rotation).toEqual([-Math.PI / 2, 0, 0])
    expect(configZ.size).toEqual([8.8, 6.1])

    const configX = getSlicePlaneConfig('x', 2.0)
    expect(configX.position).toEqual([2.0, 1.6, 3.05])
    expect(configX.rotation).toEqual([0, Math.PI / 2, 0])
    expect(configX.size).toEqual([6.1, 3.2])

    const configY = getSlicePlaneConfig('y', 3.0)
    expect(configY.position).toEqual([4.4, 1.6, 3.0])
    expect(configY.rotation).toEqual([0, 0, 0])
    expect(configY.size).toEqual([8.8, 3.2])
  })

  it('generates RGBA buffer and comfort statistics', () => {
    const mockSlice: SliceResult = {
      run: 'test-run',
      case: 'B001',
      axis: 'z',
      value: 1.1,
      shape: [2, 2],
      axes: { x: [1, 2], y: [1, 2] },
      u: [
        [0.02, 0.1],
        [0.4, 0.12],
      ],
      v: [
        [0, 0],
        [0, 0],
      ],
      w: [
        [0, 0],
        [0, 0],
      ],
      T: [
        [297.15, 297.15],
        [297.15, 297.15],
      ],
    }

    const speedBuffer = generateSliceRgbaBuffer(mockSlice, 'speed')
    expect(speedBuffer.width).toBe(2)
    expect(speedBuffer.height).toBe(2)
    expect(speedBuffer.data.length).toBe(2 * 2 * 4)

    const comfortBuffer = generateSliceRgbaBuffer(mockSlice, 'comfort')
    expect(comfortBuffer.stats.stagnantRatio).toBe(0.25) // 1/4 (v=0.02)
    expect(comfortBuffer.stats.comfortRatio).toBe(0.5) // 2/4 (v=0.1, v=0.12)
    expect(comfortBuffer.stats.draftRatio).toBe(0.25) // 1/4 (v=0.4)
  })

  it('generates sample 3D grid points and performs trilinear vector interpolation', () => {
    const sample = generateSampleGridPoints(11, 8, 5)
    expect(sample.points.length).toBe(11 * 8 * 5) // 440 points
    expect(sample.xs.length).toBe(11)
    expect(sample.ys.length).toBe(8)
    expect(sample.zs.length).toBe(5)

    const defaultGrid = createDefaultVectorField(
      [
        [2, 2],
        [4, 4],
      ],
      [
        [1, 1],
        [5, 5],
      ],
      11,
      8,
      5,
    )
    expect(defaultGrid.u.length).toBe(11)

    const vec = interpolateVectorField(defaultGrid, 2.0, 2.0, 2.5)
    expect(vec.length).toBe(3)
    // Near supply vent (2, 2) at high z (2.5), vz should be downward (negative)
    expect(vec[2]).toBeLessThan(0)
  })
})
