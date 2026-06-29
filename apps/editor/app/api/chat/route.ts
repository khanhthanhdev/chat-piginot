export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(request: Request) {
  const response = await fetch(
    `${process.env.PASCAL_AGENT_SERVER_URL ?? 'http://localhost:4111'}/chat`,
    {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      body: await request.arrayBuffer(),
      signal: request.signal,
    },
  )
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}
