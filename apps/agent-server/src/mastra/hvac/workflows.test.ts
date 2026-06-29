import { describe, expect, test } from 'bun:test'
import type { Candidate, Kpis } from './contracts'
import { optimizationRequestSchema } from './contracts'
import {
  calculateKpis,
  candidateId,
  evenlyDistributed,
  occupiedPlane,
  rankCandidates,
  terminalsFor,
  topologyValid,
} from './workflows'

const request = optimizationRequestSchema.parse({
  room: { id: 'room', minimum: [0, 0, 0], maximum: [10, 8, 3] },
  installationLines: {
    supply: { start: [1, 2, 3], end: [9, 2, 3], offsetDirection: [0, 1, 0] },
    return: { start: [1, 6, 3], end: [9, 6, 3], offsetDirection: [0, 1, 0] },
  },
  terminalDimensions: { supply: [0.5, 0.5], return: [0.5, 0.5] },
  directions: { supply: [0, 0, -1], return: [0, 0, 1] },
  totalFlowM3s: 1,
  minimumClearanceM: 0.1,
  candidateLimit: 100,
  variables: {
    supplySpacingM: { min: 1, max: 2, step: 1 },
    supplyOffsetM: { min: 0, max: 1, step: 1 },
    returnSpacingM: { min: 1, max: 2, step: 1 },
    returnOffsetM: { min: 0, max: 1, step: 1 },
  },
  grid: { shape: [2, 2, 2], origin: [0.5, 0.5, 1], spacing: [1, 1, 1], occupiedPlaneZ: 1.5 },
})

describe('HVAC workflow rules', () => {
  test('generates centred 3+3 coordinates and stable IDs', () => {
    const terminals = terminalsFor(request, {
      supplySpacingM: 2,
      supplyOffsetM: 1,
      returnSpacingM: 1,
      returnOffsetM: 0,
    })
    expect(terminals.map(({ centre }) => centre)).toEqual([
      [3, 3, 3],
      [5, 3, 3],
      [7, 3, 3],
      [4, 6, 3],
      [5, 6, 3],
      [6, 6, 3],
    ])
    expect(candidateId(terminals)).toBe(candidateId(structuredClone(terminals)))
    expect(
      topologyValid(request, {
        id: 'candidate',
        variables: {} as never,
        terminals,
        status: 'pending',
      }),
    ).toBe(true)
  })

  test('extracts an interpolated occupied plane and computes KPI boundaries', () => {
    const plane = occupiedPlane([0, 2, 0, 2, 0, 2, 0, 2], request.grid)
    expect(plane).toEqual([
      [1, 1],
      [1, 1],
    ])
    expect(calculateKpis([0.09, 0.1, 0.3, 0.31], request)).toMatchObject({
      deadZoneRatio: 0.25,
      airSweepCoverage: 0.5,
      maxVelocity: 0.31,
    })
  })

  test('selects stable candidates and ranks with deterministic Pareto flags', () => {
    expect(evenlyDistributed([0, 1, 2, 3, 4], 3)).toEqual([0, 2, 4])
    const kpis = (meanVelocity: number, deadZoneRatio: number, airSweepCoverage: number): Kpis => ({
      ach: 1,
      meanVelocity,
      maxVelocity: meanVelocity,
      deadZoneRatio,
      airSweepCoverage,
      uniformity: 1,
    })
    const candidates = [
      { id: 'b', status: 'succeeded', kpis: kpis(0.2, 0.2, 0.7) },
      { id: 'a', status: 'succeeded', kpis: kpis(0.2, 0.2, 0.7) },
      { id: 'c', status: 'succeeded', kpis: kpis(0.3, 0.3, 0.6) },
    ] as Array<Candidate & { kpis: Kpis }>
    expect(rankCandidates(candidates, request.weights).map(({ id }) => id)).toEqual(['a', 'b', 'c'])
    expect(candidates.find(({ id }) => id === 'c')?.paretoOptimal).toBe(false)
  })
})
