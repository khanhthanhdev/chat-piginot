import { readdir } from 'node:fs/promises'
import type { Mastra } from '@mastra/core/mastra'
import type { OptimizationRequest } from './contracts'
import { optimizationRequestSchema, publicCandidate } from './contracts'
import {
  addEvent,
  createRunRecord,
  deleteRunRecord,
  loadRun,
  runRoot,
  runsRoot,
  toContext,
} from './store'

const activeRuns = new Map<string, { cancel(): Promise<void>; completion: Promise<unknown> }>()

export class HvacHttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 500,
  ) {
    super(message)
  }
}

export async function startOptimization(mastra: Pick<Mastra, 'getWorkflow'>, input: unknown) {
  const request = optimizationRequestSchema.parse(input)
  const runId = crypto.randomUUID()
  const record = await createRunRecord(runId, request)
  await addEvent(record, 'hvac-optimization-workflow', 'queued')
  await executeRun(mastra, record)
  return { runId, status: 'queued' as const }
}

async function executeRun(
  mastra: Pick<Mastra, 'getWorkflow'>,
  record: Awaited<ReturnType<typeof loadRun>>,
) {
  const run = await mastra
    .getWorkflow('hvacOptimizationWorkflow')
    .createRun({ runId: record.runId })
  const { runId } = record
  const completion = run
    .start({ inputData: toContext(record) })
    .catch(async (error) => {
      try {
        const current = await loadRun(runId)
        if (current.status !== 'failed' && current.status !== 'canceled') {
          await addEvent(
            current,
            'hvac-optimization-workflow',
            'failed',
            error instanceof Error ? error.message : String(error),
          )
        }
      } catch {}
    })
    .finally(() => activeRuns.delete(runId))
  activeRuns.set(runId, { cancel: () => run.cancel(), completion })
  void completion
}

export async function recoverRuns(mastra: Pick<Mastra, 'getWorkflow'>) {
  let runIds: string[]
  try {
    runIds = await readdir(runsRoot)
  } catch {
    return
  }
  for (const runId of runIds) {
    const record = await loadRun(runId)
    if (record.status === 'queued' || record.status === 'running') await executeRun(mastra, record)
  }
}

export async function getRunStatus(runId: string) {
  const record = await loadRun(runId)
  return {
    runId,
    status: record.status,
    candidateCount: record.candidates.length,
    successfulCandidateCount: record.candidates.filter(({ status }) => status === 'succeeded')
      .length,
    errorSummary: record.errorSummary,
    lastSequence: record.events.length,
    updatedAt: record.updatedAt,
  }
}

export async function getRanking(runId: string) {
  const record = await loadRun(runId)
  return {
    ranking: record.ranking.map((id, index) => ({
      rank: index + 1,
      ...publicCandidate(runId, record.candidates.find((candidate) => candidate.id === id)!),
    })),
    failedCandidates: record.candidates
      .filter(({ status }) => status === 'failed')
      .map(({ id, error }) => ({ id, error: error ?? 'Prediction failed' })),
    candidateCount: record.candidates.length,
    successfulCandidateCount: record.ranking.length,
  }
}

export async function getCandidate(runId: string, candidateId: string) {
  return publicCandidate(runId, await getCandidateRecord(runId, candidateId))
}

export async function getCandidateRecord(runId: string, candidateId: string) {
  const record = await loadRun(runId)
  const candidate = record.candidates.find(({ id }) => id === candidateId)
  if (!candidate) throw new HvacHttpError(`Candidate '${candidateId}' not found`, 404)
  return candidate
}

export async function cancelRun(runId: string) {
  const record = await loadRun(runId)
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'canceled') {
    return { runId, status: record.status }
  }
  await addEvent(record, 'hvac-optimization-workflow', 'canceled')
  const active = activeRuns.get(runId)
  await active?.cancel()
  await active?.completion
  return { runId, status: 'canceled' as const }
}

export async function deleteRun(runId: string) {
  const active = activeRuns.get(runId)
  await active?.cancel()
  await active?.completion
  activeRuns.delete(runId)
  await deleteRunRecord(runId)
  return { runId, deleted: true }
}

export type { OptimizationRequest }
export { loadRun, runRoot }
