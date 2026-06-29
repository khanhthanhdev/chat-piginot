import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { chatRoute } from '@mastra/ai-sdk'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { LibSQLStore } from '@mastra/libsql'
import { MCPClient } from '@mastra/mcp'
import { hvacRoutes } from './hvac/routes'
import { recoverRuns } from './hvac/service'
import { dataRoot } from './hvac/store'
import { hvacTools } from './hvac/tools'
import {
  candidateGenerationWorkflow,
  evaluationWorkflow,
  hvacOptimizationWorkflow,
  predictionWorkflow,
  rankingWorkflow,
  reportWorkflow,
  topologyRulesWorkflow,
  velocityRulesWorkflow,
} from './hvac/workflows'

mkdirSync(dataRoot, { recursive: true })

const mcp = new MCPClient({
  servers: {
    pascal: {
      command: 'bunx',
      args: ['pascal-mcp', '--stdio'],
      env: {
        PASCAL_DATA_DIR:
          process.env.PASCAL_DATA_DIR ?? path.join(process.env.HOME ?? '.', '.pascal', 'data'),
      },
    },
  },
})

const hvacAgent = new Agent({
  id: 'hvac-agent',
  name: 'HVAC Agent',
  instructions: `
Gather missing optimization inputs and read Pascal scenes through MCP.
Use the HVAC workflow tools for every engineering run.
Never calculate terminal coordinates, KPIs, rules, scores, rankings, or report values yourself.
`,
  model: process.env.PIGINOT_AGENT_MODEL ?? 'openai/gpt-4.1-mini',
  tools: { ...(await mcp.listTools()), ...hvacTools },
})

export const mastra = new Mastra({
  agents: { hvacAgent },
  workflows: {
    candidateGenerationWorkflow,
    topologyRulesWorkflow,
    predictionWorkflow,
    evaluationWorkflow,
    velocityRulesWorkflow,
    rankingWorkflow,
    reportWorkflow,
    hvacOptimizationWorkflow,
  },
  storage: new LibSQLStore({
    id: 'agent-server',
    url: `file:${path.join(dataRoot, 'mastra.db')}`,
  }),
  server: {
    apiPrefix: '/mastra',
    apiRoutes: [chatRoute({ path: '/chat', agent: 'hvacAgent' }), ...hvacRoutes],
  },
  mcpServers: await mcp.toMCPServerProxies(),
})

void recoverRuns(mastra)
