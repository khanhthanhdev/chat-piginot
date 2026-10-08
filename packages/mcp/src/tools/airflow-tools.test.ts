import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAirflowTools } from './airflow-tools'

describe('airflow-tools MCP', () => {
  let client: Client

  beforeEach(async () => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    registerAirflowTools(server)
    const [srvT, cliT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(srvT), client.connect(cliT)])
  })

  test('calls query_airflow_point successfully', async () => {
    const result = await client.callTool({
      name: 'query_airflow_point',
      arguments: {
        case: 'B001',
        point: [2.0, 1.5, 1.1],
      },
    })

    expect(result.content).toBeDefined()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content.length).toBeGreaterThan(0)
    const parsed = JSON.parse(content[0]!.text)
    expect(parsed.case).toBe('B001')
    expect(parsed.point).toEqual([2.0, 1.5, 1.1])
    expect(typeof parsed.speed_ms).toBe('number')
    expect(typeof parsed.temp_celsius).toBe('number')
    expect(['comfort', 'draft', 'stagnant']).toContain(parsed.ashrae55_comfort_category)
  })

  test('calls inspect_zone_comfort for west_desks', async () => {
    const result = await client.callTool({
      name: 'inspect_zone_comfort',
      arguments: {
        case: 'B001',
        zone: 'west_desks',
        height: 1.1,
      },
    })

    expect(result.content).toBeDefined()
    const content = result.content as Array<{ type: string; text: string }>
    const parsed = JSON.parse(content[0]!.text)
    expect(parsed.zone).toBe('west_desks')
    expect(parsed.height_meters).toBe(1.1)
    expect(typeof parsed.mean_air_speed_ms).toBe('number')
    expect(typeof parsed.mean_air_temp_celsius).toBe('number')
    expect(typeof parsed.mean_draft_rate_percent).toBe('number')
    expect(parsed.verdict).toBeDefined()
  })

  test('calls set_airflow_visualization', async () => {
    const result = await client.callTool({
      name: 'set_airflow_visualization',
      arguments: {
        sliceAxis: 'z',
        sliceValue: 1.1,
        metric: 'comfort',
        show3DSlice: true,
        showParticles: true,
      },
    })

    expect(result.content).toBeDefined()
    const content = result.content as Array<{ type: string; text: string }>
    const parsed = JSON.parse(content[0]!.text)
    expect(parsed.status).toBe('applied')
    expect(parsed.configuration.sliceAxis).toBe('z')
    expect(parsed.configuration.sliceValue).toBe(1.1)
    expect(parsed.configuration.metric).toBe('comfort')
    expect(parsed.configuration.show3DSlice).toBe(true)
    expect(parsed.configuration.showParticles).toBe(true)
  })
})
