type RouteContext = { params: Promise<{ path: string[] }> }

const BACKEND_URL =
  process.env.PIGINOT_BACKEND_URL ?? process.env.PIGINOT_URL ?? 'http://localhost:8000'

export function isAllowedRequest(method: string, path: string[]) {
  if (method === 'GET') {
    return (
      (path.length === 1 && (path[0] === 'cases' || path[0] === 'models')) ||
      (path.length === 2 && path[0] === 'cases' && Boolean(path[1])) ||
      (path.length === 3 && path[0] === 'cases' && Boolean(path[1]) && path[2] === 'report')
    )
  }
  return (
    method === 'POST' &&
    ((path.length === 1 && path[0] === 'slice') ||
      (path.length === 2 && path[0] === 'cases' && path[1] === 'optimize'))
  )
}

async function proxy(request: Request, context: RouteContext) {
  const { path } = await context.params
  if (!isAllowedRequest(request.method, path)) {
    return Response.json({ error: 'Unsupported airflow API request' }, { status: 404 })
  }

  const url = new URL(request.url)
  const backendPath = path.map(encodeURIComponent).join('/')
  const headers = new Headers()
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)

  try {
    const targetUrl = `${BACKEND_URL.replace(/\/$/, '')}/${backendPath}${url.search}`
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
      cache: 'no-store',
      signal: request.signal,
    })
    const responseHeaders = new Headers()
    const responseType = response.headers.get('content-type')
    if (responseType) responseHeaders.set('content-type', responseType)
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json({ error: `Airflow backend unavailable: ${message}` }, { status: 502 })
  }
}

export const GET = proxy
export const POST = proxy
