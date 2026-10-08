type RouteContext = { params: Promise<{ path: string[] }> }

const BACKEND_URL =
  process.env.PIGINOT_BACKEND_URL ?? process.env.PIGINOT_URL ?? 'http://localhost:8000'

function isValidCaseId(id: string | undefined): boolean {
  return Boolean(id && /^[a-zA-Z0-9_-]+$/.test(id))
}

export function isAllowedRequest(method: string, path: string[]) {
  const validCase = isValidCaseId(path[1])
  if (method === 'GET') {
    return (
      (path.length === 1 &&
        (path[0] === 'cases' || path[0] === 'models' || path[0] === 'health')) ||
      (path.length === 2 && path[0] === 'cases' && validCase) ||
      (path.length === 3 &&
        path[0] === 'cases' &&
        validCase &&
        (path[2] === 'report' || path[2] === 'compare'))
    )
  }
  if (method === 'POST') {
    return (
      (path.length === 1 && (path[0] === 'slice' || path[0] === 'predict')) ||
      (path.length === 2 && path[0] === 'cases' && path[1] === 'optimize') ||
      (path.length === 3 && path[0] === 'cases' && validCase && path[2] === 'load')
    )
  }
  if (method === 'DELETE') {
    return path.length === 3 && path[0] === 'cases' && validCase && path[2] === 'load'
  }
  return false
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
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)
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
    const contentDisposition = response.headers.get('content-disposition')
    if (contentDisposition) responseHeaders.set('content-disposition', contentDisposition)
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
export const DELETE = proxy
