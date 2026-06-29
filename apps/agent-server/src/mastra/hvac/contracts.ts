import { z } from 'zod'

const finite = z.number().finite()
const positive = finite.positive()
const vec3 = z.tuple([finite, finite, finite])

export const rangeSchema = z
  .object({ min: finite, max: finite, step: positive })
  .refine(({ min, max }) => min <= max, 'Range min must not exceed max')

export const optimizationRequestSchema = z
  .object({
    room: z.object({
      id: z.string().min(1),
      minimum: vec3,
      maximum: vec3,
    }),
    installationLines: z.object({
      supply: z.object({ start: vec3, end: vec3, offsetDirection: vec3 }),
      return: z.object({ start: vec3, end: vec3, offsetDirection: vec3 }),
    }),
    terminalDimensions: z.object({
      supply: z.tuple([positive, positive]),
      return: z.tuple([positive, positive]),
    }),
    directions: z.object({ supply: vec3, return: vec3 }),
    totalFlowM3s: positive,
    minimumClearanceM: finite.nonnegative(),
    candidateLimit: z.number().int().min(1).max(1000),
    variables: z.object({
      supplySpacingM: rangeSchema,
      supplyOffsetM: rangeSchema,
      returnSpacingM: rangeSchema,
      returnOffsetM: rangeSchema,
    }),
    weights: z
      .object({
        draft: finite.nonnegative(),
        deadZone: finite.nonnegative(),
        coverage: finite.nonnegative(),
        uniformity: finite.nonnegative(),
        practicality: finite.nonnegative(),
      })
      .refine(
        (weights) =>
          Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-9,
        'Weights must sum to one',
      )
      .default({
        draft: 0.3,
        deadZone: 0.3,
        coverage: 0.2,
        uniformity: 0.1,
        practicality: 0.1,
      }),
    grid: z
      .object({
        shape: z.tuple([
          z.number().int().positive(),
          z.number().int().positive(),
          z.number().int().positive(),
        ]),
        origin: vec3,
        spacing: z.tuple([positive, positive, positive]),
        occupiedPlaneZ: finite,
      })
      .default({
        shape: [40, 32, 16],
        origin: [0.125, 0.125, 0.09375],
        spacing: [0.25, 0.25, 0.1875],
        occupiedPlaneZ: 1.5,
      }),
  })
  .superRefine((request, context) => {
    if (request.room.maximum.some((value, index) => value <= request.room.minimum[index]!)) {
      context.addIssue({ code: 'custom', message: 'Room maximum must exceed minimum' })
    }
    if (
      request.grid.occupiedPlaneZ < request.room.minimum[2] ||
      request.grid.occupiedPlaneZ > request.room.maximum[2]
    ) {
      context.addIssue({ code: 'custom', message: 'Occupied plane must be inside the room' })
    }
    if (request.variables.supplySpacingM.min <= 0 || request.variables.returnSpacingM.min <= 0) {
      context.addIssue({ code: 'custom', message: 'Terminal spacing must be positive' })
    }
  })

export type OptimizationRequest = z.infer<typeof optimizationRequestSchema>
export type Vec3 = [number, number, number]

export const optimizationContextSchema = z.object({
  runId: z.string().uuid(),
  artifactRoot: z.string(),
  candidateIds: z.array(z.string()),
  successfulCandidateIds: z.array(z.string()),
  candidateCount: z.number().int().nonnegative(),
  successfulCandidateCount: z.number().int().nonnegative(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  errorSummary: z.string().optional(),
})

export type OptimizationContext = z.infer<typeof optimizationContextSchema>

export type Terminal = {
  id: string
  role: 'supply' | 'return'
  centre: Vec3
  direction: Vec3
  faceVelocity: number
}

export type Kpis = {
  ach: number
  meanVelocity: number
  maxVelocity: number
  deadZoneRatio: number
  airSweepCoverage: number
  uniformity: number
}

export type Candidate = {
  id: string
  variables: {
    supplySpacingM: number
    supplyOffsetM: number
    returnSpacingM: number
    returnOffsetM: number
  }
  terminals: Terminal[]
  status: 'pending' | 'succeeded' | 'failed'
  error?: string
  artifact?: {
    fieldPath: string
    metadataPath: string
  }
  kpis?: Kpis
  rules?: {
    status: 'pass' | 'warning' | 'fail'
    activatedRules: string[]
    warnings: string[]
    violations: string[]
    recommendations: string[]
  }
  score?: number
  paretoOptimal?: boolean
}

export type ProgressEvent = {
  runId: string
  sequence: number
  workflowId: string
  candidateCount: number
  successfulCandidateCount: number
  status: OptimizationContext['status']
  errorSummary?: string
  timestamp: string
}

export type RunRecord = {
  runId: string
  request: OptimizationRequest
  status: OptimizationContext['status']
  candidates: Candidate[]
  ranking: string[]
  events: ProgressEvent[]
  report?: { markdownPath: string; jsonPath: string }
  errorSummary?: string
  createdAt: string
  updatedAt: string
}
