import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Candidate, Kpis } from './contracts'
import { optimizationRequestSchema, publicCandidate } from './contracts'
import {
  calculateKpis,
  candidateId,
  decodeField,
  evenlyDistributed,
  inferBatch,
  occupiedPlane,
  rankCandidates,
  terminalsFor,
  topologyValid,
  velocityRules,
} from './workflows'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

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
  test('rejects invalid room and grid inputs', () => {
    expect(() =>
      optimizationRequestSchema.parse({
        ...request,
        room: { ...request.room, maximum: [0, 8, 3] },
      }),
    ).toThrow('Room maximum must exceed minimum')
    expect(() =>
      optimizationRequestSchema.parse({
        ...request,
        grid: { ...request.grid, occupiedPlaneZ: 4 },
      }),
    ).toThrow('Occupied plane must be inside the room')
    expect(() =>
      optimizationRequestSchema.parse({
        ...request,
        variables: {
          ...request.variables,
          supplyOffsetM: { min: 0, max: 1000, step: 0.001 },
        },
      }),
    ).toThrow('at most 100000 candidates')
  })

  test('checks clearance using rotated terminal footprints', () => {
    const candidate = {
      id: 'rotated',
      variables: {} as never,
      status: 'pending' as const,
      terminals: [
        {
          id: 'supply-1',
          role: 'supply' as const,
          centre: [0.4, 4, 3] as [number, number, number],
          direction: [0, 0, -1] as [number, number, number],
          faceVelocity: 1,
          width: 1,
          depth: 0.5,
          rotation: Math.PI / 4,
        },
      ],
    }
    expect(topologyValid(request, candidate)).toBe(false)
  })

  test('reports excessive dead zones as a warning', () => {
    expect(
      velocityRules({
        ach: 1,
        meanVelocity: 0.2,
        maxVelocity: 0.2,
        deadZoneRatio: 0.25,
        airSweepCoverage: 0.6,
        uniformity: 0.8,
      }),
    ).toMatchObject({ status: 'warning', activatedRules: ['R-V3'] })
  })

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

  test('exposes artifact URLs without filesystem paths', () => {
    const candidate = {
      id: 'candidate',
      variables: {} as never,
      terminals: [],
      status: 'succeeded' as const,
      artifact: { fieldPath: '/secret/field.f32', metadataPath: '/secret/field.json' },
    }
    expect(publicCandidate('run id', candidate)).toMatchObject({
      artifactAvailable: true,
      fieldUrl: '/api/v1/hvac/runs/run%20id/candidates/candidate/field',
      planeUrl: '/api/v1/hvac/runs/run%20id/candidates/candidate/plane',
    })
    expect(JSON.stringify(publicCandidate('run id', candidate))).not.toContain('/secret')
  })

  test('rejects malformed, wrong-sized, and non-finite fields', () => {
    expect(() => decodeField('not base64', 4)).toThrow('malformed base64')
    expect(() => decodeField(Buffer.alloc(8).toString('base64'), 4)).toThrow('does not match')
    expect(() =>
      decodeField(Buffer.from(new Float32Array([Number.NaN]).buffer).toString('base64'), 4),
    ).toThrow('non-finite')
  })

  test('does not retry non-retryable inference failures', async () => {
    const fetchMock = mock(async () => new Response('invalid', { status: 400 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(inferBatch(request, [], new AbortController().signal)).rejects.toThrow(
      'failed with 400',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('aborts retry delays', async () => {
    globalThis.fetch = mock(
      async () => new Response('retry later', { status: 503 }),
    ) as unknown as typeof fetch
    const controller = new AbortController()
    const pending = inferBatch(request, [], controller.signal)
    controller.abort(new DOMException('Canceled', 'AbortError'))
    await expect(pending).rejects.toThrow('Canceled')
  })
})
