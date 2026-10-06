import { describe, expect, it } from 'bun:test'
import { isAllowedRequest } from '@/app/api/airflow/[...path]/route'

describe('Airflow API route whitelist', () => {
  it('permits valid GET requests', () => {
    expect(isAllowedRequest('GET', ['cases'])).toBe(true)
    expect(isAllowedRequest('GET', ['models'])).toBe(true)
    expect(isAllowedRequest('GET', ['cases', 'B001'])).toBe(true)
    expect(isAllowedRequest('GET', ['cases', 'D006'])).toBe(true)
    expect(isAllowedRequest('GET', ['cases', 'D006', 'report'])).toBe(true)
  })

  it('permits valid POST requests including optimization', () => {
    expect(isAllowedRequest('POST', ['slice'])).toBe(true)
    expect(isAllowedRequest('POST', ['cases', 'optimize'])).toBe(true)
  })

  it('rejects unsupported routes and methods', () => {
    expect(isAllowedRequest('DELETE', ['cases', 'B001'])).toBe(false)
    expect(isAllowedRequest('PUT', ['cases'])).toBe(false)
    expect(isAllowedRequest('GET', ['unknown'])).toBe(false)
    expect(isAllowedRequest('POST', ['cases'])).toBe(false)
    expect(isAllowedRequest('POST', ['unsupported', 'route'])).toBe(false)
  })
})
