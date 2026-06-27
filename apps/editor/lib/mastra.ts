import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'

const editorAgent = new Agent({
  id: 'editorAgent',
  name: 'Editor Agent',
  instructions:
    'You help users work in the Pascal 3D editor. Be concise, practical, and ask for missing scene details only when needed.',
  model: process.env.PASCAL_CHAT_MODEL ?? 'openai/gpt-4o-mini',
})

export const mastra = new Mastra({
  agents: {
    editorAgent,
  },
})
