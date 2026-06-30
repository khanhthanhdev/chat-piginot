import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { cpus, freemem, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { Mastra } from '@mastra/core/mastra'
import { LibSQLStore } from '@mastra/libsql'

const root = path.join(tmpdir(), `pascal-hvac-benchmark-${process.pid}`)
process.env.PASCAL_DATA_DIR = root
await mkdir(root, { recursive: true })

const workflows = await import('../src/mastra/hvac/workflows')
const { optimizationRequestSchema } = await import('../src/mastra/hvac/contracts')
const { addEvent, createRunRecord, loadRun, toContext } = await import('../src/mastra/hvac/store')

const mastra = new Mastra({
  workflows: {
    candidateGenerationWorkflow: workflows.candidateGenerationWorkflow,
    topologyRulesWorkflow: workflows.topologyRulesWorkflow,
    predictionWorkflow: workflows.predictionWorkflow,
    evaluationWorkflow: workflows.evaluationWorkflow,
    velocityRulesWorkflow: workflows.velocityRulesWorkflow,
    rankingWorkflow: workflows.rankingWorkflow,
    reportWorkflow: workflows.reportWorkflow,
    hvacOptimizationWorkflow: workflows.hvacOptimizationWorkflow,
  },
  storage: new LibSQLStore({ id: 'benchmark', url: `file:${path.join(root, 'benchmark.db')}` }),
})

const field = Buffer.from(new Float32Array(32).fill(0.15).buffer).toString('base64')
const realFetch = globalThis.fetch
globalThis.fetch = (async (_url, init) => {
  const request = JSON.parse(String(init?.body)) as {
    grid: object
    candidates: Array<{ id: string }>
  }
  return Response.json({
    model: { id: 'benchmark-mock', version: '1', source: 'benchmark' },
    grid: request.grid,
    candidates: request.candidates.map(({ id }) => ({
      id,
      status: 'succeeded',
      velocityMagnitudeBase64: field,
    })),
  })
}) as typeof fetch

const requestFor = (candidateLimit: number) =>
  optimizationRequestSchema.parse({
    room: { id: 'benchmark-room', minimum: [0, 0, 0], maximum: [20, 20, 3] },
    installationLines: {
      supply: { start: [2, 5, 3], end: [18, 5, 3], offsetDirection: [0, 1, 0] },
      return: { start: [2, 15, 3], end: [18, 15, 3], offsetDirection: [0, 1, 0] },
    },
    terminalDimensions: { supply: [0.2, 0.2], return: [0.2, 0.2] },
    directions: { supply: [0, 0, -1], return: [0, 0, 1] },
    totalFlowM3s: 1,
    minimumClearanceM: 0.1,
    candidateLimit,
    variables: {
      supplySpacingM: { min: 1, max: 6, step: 1 },
      supplyOffsetM: { min: -2, max: 3, step: 1 },
      returnSpacingM: { min: 1, max: 6, step: 1 },
      returnOffsetM: { min: -2, max: 3, step: 1 },
    },
    grid: {
      shape: [4, 4, 2],
      origin: [0.5, 0.5, 0.75],
      spacing: [1, 1, 1.5],
      occupiedPlaneZ: 1.5,
    },
  })

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    bytes += entry.isDirectory() ? await directoryBytes(target) : (await stat(target)).size
  }
  return bytes
}

try {
  const results = []
  for (const candidateLimit of [100, 1000]) {
    const runId = crypto.randomUUID()
    const record = await createRunRecord(runId, requestFor(candidateLimit))
    await addEvent(record, 'hvac-optimization-workflow', 'queued')
    const run = await mastra.getWorkflow('hvacOptimizationWorkflow').createRun({ runId })
    const started = performance.now()
    await run.start({ inputData: toContext(record) })
    const completed = await loadRun(runId)
    results.push({
      candidateLimit,
      successfulCandidates: completed.ranking.length,
      elapsedMs: Math.round(performance.now() - started),
      artifactBytes: await directoryBytes(path.join(root, 'agent-server', 'hvac-runs', runId)),
    })
  }
  console.log(
    JSON.stringify(
      {
        hardware: {
          platform: platform(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          freeMemoryBytes: freemem(),
        },
        gridShape: [4, 4, 2],
        inference: 'in-process deterministic mock',
        results,
      },
      null,
      2,
    ),
  )
} finally {
  globalThis.fetch = realFetch
  await rm(root, { recursive: true, force: true })
}
