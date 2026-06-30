import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type {
  Candidate,
  Kpis,
  ModelIdentity,
  OptimizationRequest,
  RunRecord,
  Terminal,
  Vec3,
} from './contracts'
import { optimizationContextSchema, publicCandidate } from './contracts'
import { addEvent, atomicWriteFile, loadRun, runRoot, saveRun, toContext } from './store'

type Stage = (record: RunRecord, signal: AbortSignal) => Promise<void>

function stageWorkflow(id: string, runStage: Stage) {
  const step = createStep({
    id,
    inputSchema: optimizationContextSchema,
    outputSchema: optimizationContextSchema,
    execute: async ({ inputData, abort, abortSignal }) => {
      const record = await loadRun(inputData.runId)
      if (record.status === 'canceled' || record.status === 'failed') return toContext(record)
      await addEvent(record, id, 'running')
      try {
        await runStage(record, abortSignal)
        if (abortSignal.aborted) {
          abort()
          return toContext(record)
        }
        await addEvent(record, id, record.status)
      } catch (error) {
        if (abortSignal.aborted || isAbortError(error)) {
          abort()
          return toContext(record)
        }
        const summary = error instanceof Error ? error.message : String(error)
        await addEvent(record, id, 'failed', summary)
        throw error
      }
      return toContext(record)
    },
  })
  return createWorkflow({
    id,
    inputSchema: optimizationContextSchema,
    outputSchema: optimizationContextSchema,
  })
    .then(step)
    .commit()
}

export const candidateGenerationWorkflow = stageWorkflow(
  'candidate-generation-workflow',
  async (record, signal) => {
    const { variables } = record.request
    const candidates = new Map<string, Candidate>()
    for (const supplySpacingM of values(variables.supplySpacingM)) {
      for (const supplyOffsetM of values(variables.supplyOffsetM)) {
        for (const returnSpacingM of values(variables.returnSpacingM)) {
          for (const returnOffsetM of values(variables.returnOffsetM)) {
            signal.throwIfAborted()
            const candidateVariables = {
              supplySpacingM,
              supplyOffsetM,
              returnSpacingM,
              returnOffsetM,
            }
            const terminals = terminalsFor(record.request, candidateVariables)
            const candidate = {
              id: candidateId(terminals),
              variables: candidateVariables,
              terminals,
              status: 'pending' as const,
            }
            candidates.set(candidate.id, candidate)
          }
        }
      }
    }
    record.candidates = [...candidates.values()]
    signal.throwIfAborted()
    await saveRun(record)
  },
)

export const topologyRulesWorkflow = stageWorkflow(
  'topology-rules-workflow',
  async (record, signal) => {
    signal.throwIfAborted()
    const valid = record.candidates.filter((candidate) => topologyValid(record.request, candidate))
    if (valid.length === 0)
      throw new Error('No candidate satisfies room clearance and overlap rules')
    const limit = Math.min(record.request.candidateLimit, 1000)
    record.candidates = evenlyDistributed(valid, limit)
    signal.throwIfAborted()
    await saveRun(record)
  },
)

export const predictionWorkflow = stageWorkflow('prediction-workflow', async (record, signal) => {
  const pending = []
  const expectedBytes = record.request.grid.shape.reduce((product, value) => product * value, 1) * 4
  for (const candidate of record.candidates) {
    signal.throwIfAborted()
    const actualFieldPath = path.join(runRoot(record.runId), 'fields', `${candidate.id}.f32`)
    try {
      const metadataPath = actualFieldPath.replace(/\.f32$/, '.json')
      const bytes = await readFile(actualFieldPath)
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as ArtifactMetadata
      if (validArtifact(record, candidate, bytes, metadata, expectedBytes)) {
        record.modelIdentity ??= metadata.model
        candidate.status = 'succeeded'
        candidate.artifact = {
          fieldPath: actualFieldPath,
          metadataPath,
        }
        continue
      }
    } catch {}
    pending.push(candidate)
  }

  for (let index = 0; index < pending.length; index += 25) {
    signal.throwIfAborted()
    if ((await loadRun(record.runId)).status === 'canceled') return
    const batch = pending.slice(index, index + 25)
    try {
      const response = await inferBatch(record.request, batch, signal)
      validateModel(record, response.model)
      if (
        JSON.stringify(response.grid.shape) !== JSON.stringify(record.request.grid.shape) ||
        JSON.stringify(response.grid.origin) !== JSON.stringify(record.request.grid.origin) ||
        JSON.stringify(response.grid.spacing) !== JSON.stringify(record.request.grid.spacing)
      ) {
        throw new Error('PiGINOT returned grid metadata that does not match the request')
      }
      const responseIds = response.candidates.map(({ id }) => id)
      if (new Set(responseIds).size !== responseIds.length) {
        throw new Error('PiGINOT returned duplicate candidate IDs')
      }
      for (const candidate of batch) {
        signal.throwIfAborted()
        const result = response.candidates.find((item) => item.id === candidate.id)
        if (result?.status !== 'succeeded' || !result.velocityMagnitudeBase64) {
          candidate.status = 'failed'
          candidate.error = result?.error ?? 'PiGINOT omitted the candidate result'
          continue
        }
        let bytes: Buffer
        try {
          bytes = decodeField(result.velocityMagnitudeBase64, expectedBytes)
        } catch (error) {
          candidate.status = 'failed'
          candidate.error = error instanceof Error ? error.message : String(error)
          continue
        }
        const fieldPath = path.join(runRoot(record.runId), 'fields', `${candidate.id}.f32`)
        const metadataPath = fieldPath.replace(/\.f32$/, '.json')
        await atomicWriteFile(fieldPath, bytes, signal)
        await atomicWriteFile(
          metadataPath,
          JSON.stringify(
            { model: response.model, grid: response.grid, terminals: candidate.terminals },
            null,
            2,
          ),
          signal,
        )
        candidate.status = 'succeeded'
        candidate.artifact = { fieldPath, metadataPath }
      }
    } catch (error) {
      if (signal.aborted) throw error
      const summary = error instanceof Error ? error.message : String(error)
      for (const candidate of batch) {
        candidate.status = 'failed'
        candidate.error = summary
      }
    }
    await saveRun(record)
  }
  if (!record.candidates.some(({ status }) => status === 'succeeded')) {
    throw new Error('No candidate prediction succeeded')
  }
})

export const evaluationWorkflow = stageWorkflow('evaluation-workflow', async (record, signal) => {
  for (const candidate of record.candidates) {
    signal.throwIfAborted()
    if (candidate.status !== 'succeeded' || !candidate.artifact) continue
    const bytes = await readFile(candidate.artifact.fieldPath)
    const values = Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
      bytes.readFloatLE(index * 4),
    )
    const plane = occupiedPlane(values, record.request.grid)
    candidate.kpis = calculateKpis(plane.flat(), record.request)
    const metadata = JSON.parse(await readFile(candidate.artifact.metadataPath, 'utf8')) as object
    await atomicWriteFile(
      candidate.artifact.metadataPath,
      JSON.stringify({ ...metadata, occupiedPlane: plane, kpis: candidate.kpis }, null, 2),
      signal,
    )
  }
  await saveRun(record)
})

export const velocityRulesWorkflow = stageWorkflow(
  'velocity-rules-workflow',
  async (record, signal) => {
    for (const candidate of record.candidates) {
      signal.throwIfAborted()
      if (!candidate.kpis) continue
      candidate.rules = velocityRules(candidate.kpis)
    }
    signal.throwIfAborted()
    await saveRun(record)
  },
)

export const rankingWorkflow = stageWorkflow('ranking-workflow', async (record, signal) => {
  signal.throwIfAborted()
  const candidates = record.candidates.filter(
    (candidate): candidate is Candidate & { kpis: Kpis } =>
      candidate.status === 'succeeded' && Boolean(candidate.kpis),
  )
  rankCandidates(candidates, record.request.weights)
  record.ranking = candidates.map(({ id }) => id)
  signal.throwIfAborted()
  await saveRun(record)
})

export const reportWorkflow = stageWorkflow('report-workflow', async (record, signal) => {
  const ranked = record.ranking
    .map((id) => record.candidates.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Candidate => Boolean(candidate))
  const report = {
    runId: record.runId,
    room: record.request.room,
    candidateCount: record.candidates.length,
    successfulCandidateCount: ranked.length,
    ranking: ranked.map((candidate) => publicCandidate(record.runId, candidate)),
    failedCandidates: record.candidates
      .filter(({ status }) => status === 'failed')
      .map(({ id, error }) => ({ id, error: error ?? 'Prediction failed' })),
  }
  const jsonPath = path.join(runRoot(record.runId), 'report.json')
  const markdownPath = jsonPath.replace(/\.json$/, '.md')
  const best = ranked[0]
  const markdown = [
    `# HVAC optimization ${record.runId}`,
    '',
    `Evaluated ${record.candidates.length} candidates; ${ranked.length} predictions succeeded.`,
    '',
    best
      ? `Recommended candidate: **${best.id}** with score ${(best.score ?? 0).toFixed(3)}.`
      : 'No candidate could be recommended.',
    '',
    '| Rank | Candidate | Score | Dead zone | Coverage | Pareto |',
    '| ---: | --- | ---: | ---: | ---: | :---: |',
    ...ranked.map(
      (candidate, index) =>
        `| ${index + 1} | ${candidate.id} | ${(candidate.score ?? 0).toFixed(3)} | ${(
          candidate.kpis?.deadZoneRatio ?? 0
        ).toFixed(4)} | ${(candidate.kpis?.airSweepCoverage ?? 0).toFixed(4)} | ${
          candidate.paretoOptimal ? 'yes' : 'no'
        } |`,
    ),
    '',
    '## Failed candidates',
    '',
    ...(report.failedCandidates.length
      ? report.failedCandidates.map(({ id, error }) => `- ${id}: ${error}`)
      : ['None.']),
    '',
  ].join('\n')
  await atomicWriteFile(jsonPath, JSON.stringify(report, null, 2), signal)
  await atomicWriteFile(markdownPath, markdown, signal)
  record.report = { markdownPath, jsonPath }
  record.status = 'completed'
  await saveRun(record)
})

export const hvacOptimizationWorkflow = createWorkflow({
  id: 'hvac-optimization-workflow',
  inputSchema: optimizationContextSchema,
  outputSchema: optimizationContextSchema,
})
  .then(candidateGenerationWorkflow)
  .then(topologyRulesWorkflow)
  .then(predictionWorkflow)
  .then(evaluationWorkflow)
  .then(velocityRulesWorkflow)
  .then(rankingWorkflow)
  .then(reportWorkflow)
  .commit()

function values(range: { min: number; max: number; step: number }) {
  const result = []
  for (let value = range.min; value <= range.max + range.step * 1e-9; value += range.step) {
    result.push(Number(value.toFixed(12)))
  }
  return result
}

export function candidateId(terminals: Terminal[]) {
  const canonical = terminals
    .map(({ role, centre }) => `${role}:${centre.map((value) => value.toFixed(9)).join(',')}`)
    .join('|')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export function terminalsFor(
  request: OptimizationRequest,
  variables: Candidate['variables'],
): Terminal[] {
  const flowPerTerminal = request.totalFlowM3s / 3
  return [
    ...terminalGroup(
      'supply',
      request.installationLines.supply,
      variables.supplySpacingM,
      variables.supplyOffsetM,
      request.directions.supply,
      flowPerTerminal /
        (request.terminalDimensions.supply[0] * request.terminalDimensions.supply[1]),
      request.terminalDimensions.supply,
    ),
    ...terminalGroup(
      'return',
      request.installationLines.return,
      variables.returnSpacingM,
      variables.returnOffsetM,
      request.directions.return,
      flowPerTerminal /
        (request.terminalDimensions.return[0] * request.terminalDimensions.return[1]),
      request.terminalDimensions.return,
    ),
  ]
}

function terminalGroup(
  role: 'supply' | 'return',
  line: { start: Vec3; end: Vec3; offsetDirection: Vec3 },
  spacing: number,
  offset: number,
  direction: Vec3,
  faceVelocity: number,
  dimensions: [number, number],
): Terminal[] {
  const lineDirection = unit(subtract(line.end, line.start))
  const offsetDirection = unit(line.offsetDirection)
  const midpoint = line.start.map((value, index) => (value + line.end[index]!) / 2) as Vec3
  const anchor = add(midpoint, scale(offsetDirection, offset))
  return [-1, 0, 1].map((position, index) => ({
    id: `${role}-${index + 1}`,
    role,
    centre: add(anchor, scale(lineDirection, spacing * position)),
    direction,
    faceVelocity,
    width: dimensions[0],
    depth: dimensions[1],
    rotation: Math.atan2(lineDirection[1], lineDirection[0]),
  }))
}

export function topologyValid(request: OptimizationRequest, candidate: Candidate) {
  const { minimum, maximum } = request.room
  for (const terminal of candidate.terminals) {
    const size =
      terminal.role === 'supply'
        ? request.terminalDimensions.supply
        : request.terminalDimensions.return
    const cos = Math.abs(Math.cos(terminal.rotation))
    const sin = Math.abs(Math.sin(terminal.rotation))
    const halfX = (size[0] * cos + size[1] * sin) / 2
    const halfY = (size[0] * sin + size[1] * cos) / 2
    if (
      terminal.centre[0] - halfX < minimum[0] + request.minimumClearanceM ||
      terminal.centre[0] + halfX > maximum[0] - request.minimumClearanceM ||
      terminal.centre[1] - halfY < minimum[1] + request.minimumClearanceM ||
      terminal.centre[1] + halfY > maximum[1] - request.minimumClearanceM ||
      terminal.centre[2] < minimum[2] ||
      terminal.centre[2] > maximum[2]
    )
      return false
  }
  for (let left = 0; left < candidate.terminals.length; left++) {
    for (let right = left + 1; right < candidate.terminals.length; right++) {
      const a = candidate.terminals[left]!
      const b = candidate.terminals[right]!
      if (terminalsOverlap(a, b, request.minimumClearanceM)) return false
    }
  }
  return true
}

function terminalsOverlap(a: Terminal, b: Terminal, clearance: number) {
  const axes = [a.rotation, a.rotation + Math.PI / 2, b.rotation, b.rotation + Math.PI / 2]
  const dx = b.centre[0] - a.centre[0]
  const dy = b.centre[1] - a.centre[1]
  return axes.every((angle) => {
    const x = Math.cos(angle)
    const y = Math.sin(angle)
    const distance = Math.abs(dx * x + dy * y)
    const radius = terminalRadius(a, x, y) + terminalRadius(b, x, y) + clearance
    return distance < radius
  })
}

function terminalRadius(terminal: Terminal, axisX: number, axisY: number) {
  const cos = Math.cos(terminal.rotation)
  const sin = Math.sin(terminal.rotation)
  return (
    (terminal.width / 2) * Math.abs(axisX * cos + axisY * sin) +
    (terminal.depth / 2) * Math.abs(axisX * -sin + axisY * cos)
  )
}

export function velocityRules(kpis: Kpis): NonNullable<Candidate['rules']> {
  const { meanVelocity, maxVelocity, deadZoneRatio, airSweepCoverage, uniformity } = kpis
  const violations = meanVelocity > 0.3 ? ['Mean occupied-plane velocity exceeds 0.30 m/s'] : []
  const warnings = [
    ...(maxVelocity > 0.3 ? ['Maximum occupied-plane velocity exceeds 0.30 m/s'] : []),
    ...(deadZoneRatio > 0.2 ? ['Occupied-plane dead zone exceeds 20%'] : []),
    ...(uniformity < 0.5 ? ['Velocity uniformity is below 0.50'] : []),
  ]
  return {
    status: violations.length ? 'fail' : warnings.length ? 'warning' : 'pass',
    activatedRules: [
      ...(meanVelocity > 0.3 ? ['R-V1'] : []),
      ...(maxVelocity > 0.3 ? ['R-V2'] : []),
      ...(deadZoneRatio > 0.2 ? ['R-V3'] : []),
      ...(airSweepCoverage > 0.8 ? ['R-V4'] : []),
      ...(uniformity < 0.5 ? ['R-V5'] : []),
    ],
    warnings,
    violations,
    recommendations: [
      ...(deadZoneRatio > 0.2 ? ['Reduce stagnant occupied-plane area'] : []),
      ...(maxVelocity > 0.3 ? ['Reduce local draft velocity'] : []),
    ],
  }
}

export function evenlyDistributed<T>(items: T[], limit: number) {
  if (items.length <= limit) return items
  if (limit === 1) return [items[0]!]
  return Array.from(
    { length: limit },
    (_, index) => items[Math.round((index * (items.length - 1)) / (limit - 1))]!,
  )
}

export async function inferBatch(
  request: OptimizationRequest,
  candidates: Candidate[],
  signal: AbortSignal,
) {
  const url = `${process.env.PIGINOT_URL ?? 'http://localhost:8000'}/api/v1/hvac-inference-batch`
  const payload = {
    room: request.room,
    grid: request.grid,
    candidates: candidates.map(({ id, terminals }) => ({ id, terminals })),
  }
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (response.ok) {
      return (await response.json()) as {
        model: { id: string; version: string; source: string }
        grid: OptimizationRequest['grid']
        candidates: Array<{
          id: string
          status: 'succeeded' | 'failed'
          velocityMagnitudeBase64?: string
          error?: string
        }>
      }
    }
    if (![429, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error(
        `PiGINOT batch request failed with ${response.status}: ${await response.text()}`,
      )
    }
    await abortableDelay((attempt + 1) * 1000, signal)
  }
}

type ArtifactMetadata = {
  model?: ModelIdentity
  grid?: OptimizationRequest['grid']
  terminals?: Terminal[]
}

function validArtifact(
  record: RunRecord,
  candidate: Candidate,
  bytes: Buffer,
  metadata: ArtifactMetadata,
  expectedBytes: number,
) {
  return (
    bytes.byteLength === expectedBytes &&
    finiteFloat32(bytes) &&
    Boolean(metadata.model?.id && metadata.model.version && metadata.model.source) &&
    (!record.modelIdentity ||
      JSON.stringify(metadata.model) === JSON.stringify(record.modelIdentity)) &&
    JSON.stringify(metadata.grid) === JSON.stringify(record.request.grid) &&
    JSON.stringify(metadata.terminals) === JSON.stringify(candidate.terminals)
  )
}

function finiteFloat32(bytes: Buffer) {
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    if (!Number.isFinite(bytes.readFloatLE(offset))) return false
  }
  return true
}

export function decodeField(encoded: string, expectedBytes: number) {
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw new Error('PiGINOT returned malformed base64')
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`Field size ${bytes.byteLength} does not match expected ${expectedBytes}`)
  }
  if (!finiteFloat32(bytes)) throw new Error('PiGINOT returned non-finite field values')
  return bytes
}

function validateModel(record: RunRecord, model: ModelIdentity) {
  if (!(model?.id && model.version && model.source)) {
    throw new Error('PiGINOT omitted model identity')
  }
  if (model.source === 'analytic-test-fixture' && process.env.PIGINOT_ALLOW_SYNTHETIC !== 'true') {
    throw new Error('Synthetic PiGINOT predictions are disabled')
  }
  if (record.modelIdentity && JSON.stringify(record.modelIdentity) !== JSON.stringify(model)) {
    throw new Error('PiGINOT model identity changed during the run')
  }
  record.modelIdentity = model
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function isAbortError(error: unknown) {
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

export function occupiedPlane(field: number[], grid: OptimizationRequest['grid']): number[][] {
  const [nx, ny, nz] = grid.shape
  const position = (grid.occupiedPlaneZ - grid.origin[2]) / grid.spacing[2]
  const lower = clamp(Math.floor(position), 0, nz - 1)
  const upper = clamp(Math.ceil(position), 0, nz - 1)
  const weight = lower === upper ? 0 : position - Math.floor(position)
  return Array.from({ length: nx }, (_, x) =>
    Array.from({ length: ny }, (_, y) => {
      const base = (x * ny + y) * nz
      return field[base + lower]! * (1 - weight) + field[base + upper]! * weight
    }),
  )
}

export function calculateKpis(values: number[], request: OptimizationRequest): Kpis {
  const meanVelocity = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - meanVelocity) ** 2, 0) / values.length
  return {
    ach:
      (request.totalFlowM3s * 3600) /
      ((request.room.maximum[0] - request.room.minimum[0]) *
        (request.room.maximum[1] - request.room.minimum[1]) *
        (request.room.maximum[2] - request.room.minimum[2])),
    meanVelocity,
    maxVelocity: Math.max(...values),
    deadZoneRatio: values.filter((value) => value < 0.1).length / values.length,
    airSweepCoverage: values.filter((value) => value >= 0.1 && value <= 0.3).length / values.length,
    uniformity: meanVelocity === 0 ? 0 : clamp(1 - Math.sqrt(variance) / meanVelocity, 0, 1),
  }
}

export function rankCandidates(
  candidates: Array<Candidate & { kpis: Kpis }>,
  weights: OptimizationRequest['weights'],
) {
  for (const candidate of candidates) {
    const { meanVelocity, maxVelocity, deadZoneRatio, airSweepCoverage, uniformity } =
      candidate.kpis
    const draft =
      1 -
      clamp(
        (Math.max(0, meanVelocity - 0.3) / 0.3 + Math.max(0, maxVelocity - 0.3) / 0.3) / 2,
        0,
        1,
      )
    candidate.score =
      100 *
      (weights.draft * draft +
        weights.deadZone * (1 - deadZoneRatio) +
        weights.coverage * airSweepCoverage +
        weights.uniformity * uniformity +
        weights.practicality)
    candidate.paretoOptimal = !candidates.some(
      (other) =>
        other.id !== candidate.id &&
        other.kpis.meanVelocity <= meanVelocity &&
        other.kpis.deadZoneRatio <= deadZoneRatio &&
        other.kpis.airSweepCoverage >= airSweepCoverage &&
        (other.kpis.meanVelocity < meanVelocity ||
          other.kpis.deadZoneRatio < deadZoneRatio ||
          other.kpis.airSweepCoverage > airSweepCoverage),
    )
  }
  return candidates.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      a.kpis.deadZoneRatio - b.kpis.deadZoneRatio ||
      b.kpis.airSweepCoverage - a.kpis.airSweepCoverage ||
      a.id.localeCompare(b.id),
  )
}

function unit(vector: Vec3): Vec3 {
  const magnitude = Math.hypot(...vector)
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new Error('Direction vectors must be finite and non-zero')
  return vector.map((value) => value / magnitude) as Vec3
}

function add(left: Vec3, right: Vec3): Vec3 {
  return left.map((value, index) => value + right[index]!) as Vec3
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return left.map((value, index) => value - right[index]!) as Vec3
}

function scale(vector: Vec3, scalar: number): Vec3 {
  return vector.map((value) => value * scalar) as Vec3
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}
