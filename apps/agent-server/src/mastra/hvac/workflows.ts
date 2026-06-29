import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { Candidate, Kpis, OptimizationRequest, RunRecord, Terminal, Vec3 } from './contracts'
import { optimizationContextSchema } from './contracts'
import { addEvent, loadRun, runRoot, saveRun, toContext } from './store'

type Stage = (record: RunRecord) => Promise<void>

function stageWorkflow(id: string, runStage: Stage) {
  const step = createStep({
    id,
    inputSchema: optimizationContextSchema,
    outputSchema: optimizationContextSchema,
    execute: async ({ inputData }) => {
      const record = await loadRun(inputData.runId)
      if (record.status === 'canceled' || record.status === 'failed') return toContext(record)
      await addEvent(record, id, 'running')
      try {
        await runStage(record)
        await addEvent(record, id, record.status)
      } catch (error) {
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
  async (record) => {
    const { variables } = record.request
    const candidates: Candidate[] = []
    for (const supplySpacingM of values(variables.supplySpacingM)) {
      for (const supplyOffsetM of values(variables.supplyOffsetM)) {
        for (const returnSpacingM of values(variables.returnSpacingM)) {
          for (const returnOffsetM of values(variables.returnOffsetM)) {
            const candidateVariables = {
              supplySpacingM,
              supplyOffsetM,
              returnSpacingM,
              returnOffsetM,
            }
            const terminals = terminalsFor(record.request, candidateVariables)
            candidates.push({
              id: candidateId(terminals),
              variables: candidateVariables,
              terminals,
              status: 'pending',
            })
          }
        }
      }
    }
    record.candidates = [
      ...new Map(candidates.map((candidate) => [candidate.id, candidate])).values(),
    ]
    await saveRun(record)
  },
)

export const topologyRulesWorkflow = stageWorkflow('topology-rules-workflow', async (record) => {
  const valid = record.candidates.filter((candidate) => topologyValid(record.request, candidate))
  if (valid.length === 0) throw new Error('No candidate satisfies room clearance and overlap rules')
  const limit = Math.min(record.request.candidateLimit, 1000)
  record.candidates = evenlyDistributed(valid, limit)
  await saveRun(record)
})

export const predictionWorkflow = stageWorkflow('prediction-workflow', async (record) => {
  const pending = []
  const expectedBytes = record.request.grid.shape.reduce((product, value) => product * value, 1) * 4
  for (const candidate of record.candidates) {
    const actualFieldPath = path.join(runRoot(record.runId), 'fields', `${candidate.id}.f32`)
    try {
      const metadataPath = actualFieldPath.replace(/\.f32$/, '.json')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        grid?: { shape?: number[] }
      }
      if (
        (await readFile(actualFieldPath)).byteLength === expectedBytes &&
        JSON.stringify(metadata.grid?.shape) === JSON.stringify(record.request.grid.shape)
      ) {
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
    if ((await loadRun(record.runId)).status === 'canceled') return
    const batch = pending.slice(index, index + 25)
    try {
      const response = await inferBatch(record.request, batch)
      if (
        JSON.stringify(response.grid.shape) !== JSON.stringify(record.request.grid.shape) ||
        JSON.stringify(response.grid.origin) !== JSON.stringify(record.request.grid.origin) ||
        JSON.stringify(response.grid.spacing) !== JSON.stringify(record.request.grid.spacing)
      ) {
        throw new Error('PiGINOT returned grid metadata that does not match the request')
      }
      for (const candidate of batch) {
        const result = response.candidates.find((item) => item.id === candidate.id)
        if (result?.status !== 'succeeded' || !result.velocityMagnitudeBase64) {
          candidate.status = 'failed'
          candidate.error = result?.error ?? 'PiGINOT omitted the candidate result'
          continue
        }
        const bytes = Buffer.from(result.velocityMagnitudeBase64, 'base64')
        if (bytes.toString('base64') !== result.velocityMagnitudeBase64) {
          candidate.status = 'failed'
          candidate.error = 'PiGINOT returned malformed base64'
          continue
        }
        if (bytes.byteLength !== expectedBytes) {
          candidate.status = 'failed'
          candidate.error = `Field size ${bytes.byteLength} does not match expected ${expectedBytes}`
          continue
        }
        const fieldPath = path.join(runRoot(record.runId), 'fields', `${candidate.id}.f32`)
        const metadataPath = fieldPath.replace(/\.f32$/, '.json')
        await writeFile(fieldPath, bytes)
        await writeFile(
          metadataPath,
          JSON.stringify(
            { model: response.model, grid: response.grid, terminals: candidate.terminals },
            null,
            2,
          ),
        )
        candidate.status = 'succeeded'
        candidate.artifact = { fieldPath, metadataPath }
      }
    } catch (error) {
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

export const evaluationWorkflow = stageWorkflow('evaluation-workflow', async (record) => {
  for (const candidate of record.candidates) {
    if (candidate.status !== 'succeeded' || !candidate.artifact) continue
    const bytes = await readFile(candidate.artifact.fieldPath)
    const values = Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
      bytes.readFloatLE(index * 4),
    )
    const plane = occupiedPlane(values, record.request.grid)
    candidate.kpis = calculateKpis(plane.flat(), record.request)
    const metadata = JSON.parse(await readFile(candidate.artifact.metadataPath, 'utf8')) as object
    await writeFile(
      candidate.artifact.metadataPath,
      JSON.stringify({ ...metadata, occupiedPlane: plane, kpis: candidate.kpis }, null, 2),
    )
  }
  await saveRun(record)
})

export const velocityRulesWorkflow = stageWorkflow('velocity-rules-workflow', async (record) => {
  for (const candidate of record.candidates) {
    if (!candidate.kpis) continue
    const { meanVelocity, maxVelocity, deadZoneRatio, airSweepCoverage, uniformity } =
      candidate.kpis
    const violations = meanVelocity > 0.3 ? ['Mean occupied-plane velocity exceeds 0.30 m/s'] : []
    const warnings = [
      ...(maxVelocity > 0.3 ? ['Maximum occupied-plane velocity exceeds 0.30 m/s'] : []),
      ...(uniformity < 0.5 ? ['Velocity uniformity is below 0.50'] : []),
    ]
    const activatedRules = [
      ...(meanVelocity > 0.3 ? ['R-V1'] : []),
      ...(maxVelocity > 0.3 ? ['R-V2'] : []),
      ...(deadZoneRatio > 0.2 ? ['R-V3'] : []),
      ...(airSweepCoverage > 0.8 ? ['R-V4'] : []),
      ...(uniformity < 0.5 ? ['R-V5'] : []),
    ]
    candidate.rules = {
      status: violations.length ? 'fail' : warnings.length ? 'warning' : 'pass',
      activatedRules,
      warnings,
      violations,
      recommendations: [
        ...(deadZoneRatio > 0.2 ? ['Reduce stagnant occupied-plane area'] : []),
        ...(maxVelocity > 0.3 ? ['Reduce local draft velocity'] : []),
      ],
    }
  }
  await saveRun(record)
})

export const rankingWorkflow = stageWorkflow('ranking-workflow', async (record) => {
  const candidates = record.candidates.filter(
    (candidate): candidate is Candidate & { kpis: Kpis } =>
      candidate.status === 'succeeded' && Boolean(candidate.kpis),
  )
  rankCandidates(candidates, record.request.weights)
  record.ranking = candidates.map(({ id }) => id)
  await saveRun(record)
})

export const reportWorkflow = stageWorkflow('report-workflow', async (record) => {
  const ranked = record.ranking
    .map((id) => record.candidates.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Candidate => Boolean(candidate))
  const report = {
    runId: record.runId,
    room: record.request.room,
    candidateCount: record.candidates.length,
    successfulCandidateCount: ranked.length,
    ranking: ranked.map(
      ({ id, variables, terminals, kpis, score, paretoOptimal, rules, artifact }) => ({
        id,
        variables,
        terminals,
        kpis,
        score,
        paretoOptimal,
        rules,
        artifact,
      }),
    ),
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
  ].join('\n')
  await writeFile(jsonPath, JSON.stringify(report, null, 2))
  await writeFile(markdownPath, markdown)
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
    ),
    ...terminalGroup(
      'return',
      request.installationLines.return,
      variables.returnSpacingM,
      variables.returnOffsetM,
      request.directions.return,
      flowPerTerminal /
        (request.terminalDimensions.return[0] * request.terminalDimensions.return[1]),
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
  }))
}

export function topologyValid(request: OptimizationRequest, candidate: Candidate) {
  const { minimum, maximum } = request.room
  for (const terminal of candidate.terminals) {
    const size =
      terminal.role === 'supply'
        ? request.terminalDimensions.supply
        : request.terminalDimensions.return
    if (
      terminal.centre[0] - size[0] / 2 < minimum[0] + request.minimumClearanceM ||
      terminal.centre[0] + size[0] / 2 > maximum[0] - request.minimumClearanceM ||
      terminal.centre[1] - size[1] / 2 < minimum[1] + request.minimumClearanceM ||
      terminal.centre[1] + size[1] / 2 > maximum[1] - request.minimumClearanceM ||
      terminal.centre[2] < minimum[2] ||
      terminal.centre[2] > maximum[2]
    )
      return false
  }
  for (let left = 0; left < candidate.terminals.length; left++) {
    for (let right = left + 1; right < candidate.terminals.length; right++) {
      const a = candidate.terminals[left]!
      const b = candidate.terminals[right]!
      const aSize =
        a.role === 'supply' ? request.terminalDimensions.supply : request.terminalDimensions.return
      const bSize =
        b.role === 'supply' ? request.terminalDimensions.supply : request.terminalDimensions.return
      const gapX = Math.abs(a.centre[0] - b.centre[0]) - (aSize[0] + bSize[0]) / 2
      const gapY = Math.abs(a.centre[1] - b.centre[1]) - (aSize[1] + bSize[1]) / 2
      if (gapX < request.minimumClearanceM && gapY < request.minimumClearanceM) return false
    }
  }
  return true
}

export function evenlyDistributed<T>(items: T[], limit: number) {
  if (items.length <= limit) return items
  if (limit === 1) return [items[0]!]
  return Array.from(
    { length: limit },
    (_, index) => items[Math.round((index * (items.length - 1)) / (limit - 1))]!,
  )
}

async function inferBatch(request: OptimizationRequest, candidates: Candidate[]) {
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
      signal: AbortSignal.timeout(30_000),
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
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000))
  }
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
