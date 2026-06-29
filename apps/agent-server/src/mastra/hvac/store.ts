import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  OptimizationContext,
  OptimizationRequest,
  ProgressEvent,
  RunRecord,
} from './contracts'

export const dataRoot = path.resolve(
  process.env.PASCAL_DATA_DIR ?? path.join(process.env.HOME ?? '.', '.pascal', 'data'),
  'agent-server',
)
export const runsRoot = path.join(dataRoot, 'hvac-runs')

export function runRoot(runId: string) {
  return path.join(runsRoot, runId)
}

export async function createRunRecord(runId: string, request: OptimizationRequest) {
  const now = new Date().toISOString()
  const record: RunRecord = {
    runId,
    request,
    status: 'queued',
    candidates: [],
    ranking: [],
    events: [],
    createdAt: now,
    updatedAt: now,
  }
  await mkdir(path.join(runRoot(runId), 'fields'), { recursive: true })
  await saveRun(record)
  return record
}

export async function loadRun(runId: string): Promise<RunRecord> {
  return JSON.parse(await readFile(path.join(runRoot(runId), 'run.json'), 'utf8')) as RunRecord
}

export async function saveRun(record: RunRecord) {
  record.updatedAt = new Date().toISOString()
  const target = path.join(runRoot(record.runId), 'run.json')
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(record, null, 2))
  await rename(temporary, target)
}

export async function deleteRunRecord(runId: string) {
  await rm(runRoot(runId), { recursive: true, force: true })
}

export async function addEvent(
  record: RunRecord,
  workflowId: string,
  status: OptimizationContext['status'],
  errorSummary?: string,
) {
  const event: ProgressEvent = {
    runId: record.runId,
    sequence: record.events.length + 1,
    workflowId,
    candidateCount: record.candidates.length,
    successfulCandidateCount: record.candidates.filter(
      (candidate) => candidate.status === 'succeeded',
    ).length,
    status,
    errorSummary,
    timestamp: new Date().toISOString(),
  }
  record.events.push(event)
  record.status = status
  record.errorSummary = errorSummary
  await saveRun(record)
  return event
}

export function toContext(record: RunRecord): OptimizationContext {
  return {
    runId: record.runId,
    artifactRoot: runRoot(record.runId),
    candidateIds: record.candidates.map(({ id }) => id),
    successfulCandidateIds: record.candidates
      .filter(({ status }) => status === 'succeeded')
      .map(({ id }) => id),
    candidateCount: record.candidates.length,
    successfulCandidateCount: record.candidates.filter(({ status }) => status === 'succeeded')
      .length,
    status: record.status,
    errorSummary: record.errorSummary,
  }
}
