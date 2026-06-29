import { readFile } from 'node:fs/promises'
import { registerApiRoute } from '@mastra/core/server'
import { ZodError } from 'zod'
import {
  cancelRun,
  deleteRun,
  getCandidate,
  getRanking,
  getRunStatus,
  loadRun,
  startOptimization,
} from './service'

const jsonError = (error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: error instanceof SyntaxError || error instanceof ZodError ? 400 : 404 },
  )

export const hvacRoutes = [
  registerApiRoute('/api/v1/hvac/runs', {
    method: 'POST',
    handler: async (c) => {
      try {
        return c.json(await startOptimization(c.get('mastra'), await c.req.json()), 202)
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/status', {
    method: 'GET',
    handler: async (c) => {
      try {
        return c.json(await getRunStatus(c.req.param('runId')))
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/events', {
    method: 'GET',
    handler: async (c) => {
      const runId = c.req.param('runId')
      try {
        await loadRun(runId)
      } catch (error) {
        return jsonError(error)
      }
      const encoder = new TextEncoder()
      let sequence = 0
      return new Response(
        new ReadableStream({
          async start(controller) {
            while (!c.req.raw.signal.aborted) {
              const record = await loadRun(runId)
              for (const event of record.events.slice(sequence)) {
                controller.enqueue(
                  encoder.encode(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`),
                )
              }
              sequence = record.events.length
              if (['completed', 'failed', 'canceled'].includes(record.status)) break
              await new Promise((resolve) => setTimeout(resolve, 250))
            }
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
      )
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/ranking', {
    method: 'GET',
    handler: async (c) => {
      try {
        return c.json(await getRanking(c.req.param('runId')))
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/candidates/:candidateId', {
    method: 'GET',
    handler: async (c) => {
      try {
        return c.json(await getCandidate(c.req.param('runId'), c.req.param('candidateId')))
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/candidates/:candidateId/field', {
    method: 'GET',
    handler: async (c) => {
      try {
        const candidate = await getCandidate(c.req.param('runId'), c.req.param('candidateId'))
        if (!candidate.artifact) throw new Error('Candidate field is unavailable')
        return new Response(await readFile(candidate.artifact.fieldPath), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/candidates/:candidateId/plane', {
    method: 'GET',
    handler: async (c) => {
      try {
        const candidate = await getCandidate(c.req.param('runId'), c.req.param('candidateId'))
        if (!candidate.artifact) throw new Error('Candidate occupied plane is unavailable')
        const metadata = JSON.parse(await readFile(candidate.artifact.metadataPath, 'utf8')) as {
          occupiedPlane?: number[][]
        }
        return c.json({ occupiedPlane: metadata.occupiedPlane })
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/report', {
    method: 'GET',
    handler: async (c) => {
      try {
        const record = await loadRun(c.req.param('runId'))
        if (!record.report) throw new Error('Run report is unavailable')
        const json = c.req.query('format') === 'json'
        return new Response(
          await readFile(json ? record.report.jsonPath : record.report.markdownPath),
          {
            headers: { 'content-type': json ? 'application/json' : 'text/markdown; charset=utf-8' },
          },
        )
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId/cancel', {
    method: 'POST',
    handler: async (c) => {
      try {
        return c.json(await cancelRun(c.req.param('runId')))
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
  registerApiRoute('/api/v1/hvac/runs/:runId', {
    method: 'DELETE',
    handler: async (c) => {
      try {
        return c.json(await deleteRun(c.req.param('runId')))
      } catch (error) {
        return jsonError(error)
      }
    },
  }),
]
