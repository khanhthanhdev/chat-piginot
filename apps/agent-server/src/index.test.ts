import { describe, expect, it } from 'bun:test'
import { mastra } from './mastra/index'

describe('agent-server', () => {
  it('loads module definition', () => {
    expect(mastra).toBeDefined()
  })
})
