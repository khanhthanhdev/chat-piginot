import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
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
const pendingWrites = new Map<string, Promise<void>>()

export function runRoot(runId: string) {
  return path.join(runsRoot, runId)
}

export async function createRunRecord(runId: string, request: OptimizationRequest) {
  await pruneRuns()
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
  const target = path.join(runRoot(record.runId), 'run.json')
  const previous = pendingWrites.get(target) ?? Promise.resolve()
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      if (record.status !== 'canceled') {
        try {
          const current = JSON.parse(await readFile(target, 'utf8')) as RunRecord
          if (current.status === 'canceled') {
            Object.assign(record, current)
            return
          }
        } catch {}
      }
      record.updatedAt = new Date().toISOString()
      await atomicWriteFile(target, JSON.stringify(record, null, 2))
    })
  pendingWrites.set(target, write)
  try {
    await write
  } finally {
    if (pendingWrites.get(target) === write) pendingWrites.delete(target)
  }
}

export async function atomicWriteFile(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  signal?: AbortSignal,
) {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { signal })
    signal?.throwIfAborted()
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function deleteRunRecord(runId: string) {
  await rm(runRoot(runId), { recursive: true, force: true })
}

export async function pruneRuns() {
  const cutoff = Date.now() - Number(process.env.PASCAL_HVAC_RUN_TTL_HOURS ?? '24') * 60 * 60 * 1000
  for (const entry of await readdir(runsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    try {
      const record = await loadRun(entry.name)
      if (
        ['completed', 'failed', 'canceled'].includes(record.status) &&
        Date.parse(record.updatedAt) < cutoff
      )
        await deleteRunRecord(entry.name)
    } catch {
      // Corrupt records require manual inspection.
    }
  }
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
