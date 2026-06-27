import { handleChatStream } from '@mastra/ai-sdk'
import { createUIMessageStreamResponse } from 'ai'
import { mastra } from '@/lib/mastra'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(request: Request) {
  const params = await request.json()
  const stream = await handleChatStream({
    mastra,
    agentId: 'editorAgent',
    params: params as never,
    version: 'v6',
  })

  return createUIMessageStreamResponse({ stream: stream as never })
}
