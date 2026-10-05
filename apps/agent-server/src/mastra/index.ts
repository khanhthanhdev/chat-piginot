import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Mastra } from '@mastra/core/mastra'
import { LibSQLStore } from '@mastra/libsql'
import { MCPClient } from '@mastra/mcp'

const pascalDataDir =
  process.env.PASCAL_DATA_DIR ?? path.join(process.env.HOME ?? '.', '.pascal', 'data')
const dataRoot = path.join(pascalDataDir, 'agent-server')

mkdirSync(dataRoot, { recursive: true })

const mcp = new MCPClient({
  servers: {
    pascal: {
      command: 'bunx',
      args: ['--bun', '--package', '@pascal-app/mcp', 'pascal-mcp', '--stdio'],
      env: { PASCAL_DATA_DIR: pascalDataDir },
    },
  },
})

export const mastra = new Mastra({
  storage: new LibSQLStore({
    id: 'agent-server',
    url: `file:${path.join(dataRoot, 'mastra.db')}`,
  }),
  mcpServers: await mcp.toMCPServerProxies(),
})
