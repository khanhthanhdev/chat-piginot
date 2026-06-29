import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { optimizationRequestSchema } from './contracts'
import {
  cancelRun,
  deleteRun,
  getCandidate,
  getRanking,
  getRunStatus,
  startOptimization,
} from './service'

const runIdSchema = z.object({ runId: z.string().uuid() })

export const startOptimizationTool = createTool({
  id: 'startOptimization',
  description: 'Start the deterministic 3+3 HVAC optimization workflow.',
  inputSchema: optimizationRequestSchema,
  outputSchema: z.object({ runId: z.string().uuid(), status: z.literal('queued') }),
  execute: async (input, context) => {
    if (!context.mastra) throw new Error('Mastra runtime is unavailable')
    return startOptimization(context.mastra, input)
  },
})

export const getRunStatusTool = createTool({
  id: 'getRunStatus',
  description: 'Get HVAC optimization progress and failure summary.',
  inputSchema: runIdSchema,
  execute: ({ runId }) => getRunStatus(runId),
})

export const getRankingTool = createTool({
  id: 'getRanking',
  description: 'Get the complete deterministic ranking for an HVAC run.',
  inputSchema: runIdSchema,
  execute: ({ runId }) => getRanking(runId),
})

export const getCandidateTool = createTool({
  id: 'getCandidate',
  description: 'Get one ranked HVAC candidate and its artifact references.',
  inputSchema: runIdSchema.extend({ candidateId: z.string().min(1) }),
  execute: ({ runId, candidateId }) => getCandidate(runId, candidateId),
})

export const cancelRunTool = createTool({
  id: 'cancelRun',
  description: 'Cancel an active HVAC optimization run.',
  inputSchema: runIdSchema,
  execute: ({ runId }) => cancelRun(runId),
})

export const deleteRunTool = createTool({
  id: 'deleteRun',
  description: 'Delete a run and all retained field and report artifacts.',
  inputSchema: runIdSchema,
  execute: ({ runId }) => deleteRun(runId),
})

export const hvacTools = {
  startOptimization: startOptimizationTool,
  getRunStatus: getRunStatusTool,
  getRanking: getRankingTool,
  getCandidate: getCandidateTool,
  cancelRun: cancelRunTool,
  deleteRun: deleteRunTool,
}
