import { describe, expect, it } from 'bun:test'
import { DELETE, GET, isAllowedRequest, POST } from '@/app/api/airflow/[...path]/route'

describe('Airflow API route whitelist', () => {
  it('permits valid GET requests', () => {
    expect(isAllowedRequest('GET', ['cases'])).toBe(true)
    expect(isAllowedRequest('GET', ['models'])).toBe(true)
    expect(isAllowedRequest('GET', ['health'])).toBe(true)
    expect(isAllowedRequest('GET', ['cases', 'B001'])).toBe(true)
    expect(isAllowedRequest('GET', ['cases', 'D006'])).toBe(true)
    expect(isAllowedRequest('GET', ['cases', 'D006', 'report'])).toBe(true)
    expect(isAllowedRequest('GET', ['cases', 'D006', 'compare'])).toBe(true)
  })

  it('permits valid POST requests including optimization, prediction, and loading', () => {
    expect(isAllowedRequest('POST', ['slice'])).toBe(true)
    expect(isAllowedRequest('POST', ['predict'])).toBe(true)
    expect(isAllowedRequest('POST', ['cases', 'optimize'])).toBe(true)
    expect(isAllowedRequest('POST', ['cases', 'B001', 'load'])).toBe(true)
  })

  it('permits valid DELETE requests for cache eviction', () => {
    expect(isAllowedRequest('DELETE', ['cases', 'B001', 'load'])).toBe(true)
  })

  it('rejects unsupported routes and methods', () => {
    expect(isAllowedRequest('DELETE', ['cases', 'B001'])).toBe(false)
    expect(isAllowedRequest('DELETE', ['cases'])).toBe(false)
    expect(isAllowedRequest('PUT', ['cases'])).toBe(false)
    expect(isAllowedRequest('GET', ['unknown'])).toBe(false)
    expect(isAllowedRequest('POST', ['cases'])).toBe(false)
    expect(isAllowedRequest('POST', ['unsupported', 'route'])).toBe(false)
    expect(isAllowedRequest('POST', ['health'])).toBe(false)
    expect(isAllowedRequest('GET', ['predict'])).toBe(false)
    expect(isAllowedRequest('DELETE', ['predict'])).toBe(false)
    expect(isAllowedRequest('DELETE', ['cases', 'B001', 'compare'])).toBe(false)
  })

  it('rejects path traversal and malformed case identifiers', () => {
    expect(isAllowedRequest('GET', ['cases', '..'])).toBe(false)
    expect(isAllowedRequest('GET', ['cases', '.'])).toBe(false)
    expect(isAllowedRequest('GET', ['cases', '..', 'report'])).toBe(false)
    expect(isAllowedRequest('GET', ['cases', '..', 'compare'])).toBe(false)
    expect(isAllowedRequest('GET', ['cases', '../etc/passwd', 'report'])).toBe(false)
    expect(isAllowedRequest('POST', ['cases', '..', 'load'])).toBe(false)
    expect(isAllowedRequest('DELETE', ['cases', '..', 'load'])).toBe(false)
    expect(isAllowedRequest('DELETE', ['cases', '', 'load'])).toBe(false)
    expect(isAllowedRequest('GET', ['cases', 'bad/id', 'report'])).toBe(false)
  })
})

describe('Airflow API route proxy handler', () => {
  it('returns 404 for disallowed routes without contacting backend', async () => {
    const req = new Request('http://localhost:3000/api/airflow/unsupported')
    const res = await GET(req, { params: Promise.resolve({ path: ['unsupported'] }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('Unsupported airflow API request')
  })

  it('returns 404 for path traversal attempts', async () => {
    const req = new Request('http://localhost:3000/api/airflow/cases/../report')
    const res = await GET(req, { params: Promise.resolve({ path: ['cases', '..', 'report'] }) })
    expect(res.status).toBe(404)
  })

  it('proxies GET requests when backend responds', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain('/cases/B001')
      return new Response(
        JSON.stringify({ case: 'B001', room: { min: [0, 0, 0], max: [8, 6, 3] } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    try {
      const req = new Request('http://localhost:3000/api/airflow/cases/B001')
      const res = await GET(req, { params: Promise.resolve({ path: ['cases', 'B001'] }) })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.case).toBe('B001')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('proxies POST requests with body and query parameters', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/slice')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({ run: 'run1', case: 'B001', u: [[0.1]] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const req = new Request('http://localhost:3000/api/airflow/slice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ case: 'B001', axis: 'z', value: 1.1, spacing: 0.2 }),
      })
      const res = await POST(req, { params: Promise.resolve({ path: ['slice'] }) })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.case).toBe('B001')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('proxies DELETE requests for case cache eviction', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/cases/B001/load')
      expect(init?.method).toBe('DELETE')
      return new Response(JSON.stringify({ loaded_cases: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const req = new Request('http://localhost:3000/api/airflow/cases/B001/load', {
        method: 'DELETE',
      })
      const res = await DELETE(req, {
        params: Promise.resolve({ path: ['cases', 'B001', 'load'] }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.loaded_cases).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns 502 when backend is unreachable', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('Connection refused')
    }) as typeof fetch

    try {
      const req = new Request('http://localhost:3000/api/airflow/health')
      const res = await GET(req, { params: Promise.resolve({ path: ['health'] }) })
      expect(res.status).toBe(502)
      const data = await res.json()
      expect(data.error).toContain('Airflow backend unavailable')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
