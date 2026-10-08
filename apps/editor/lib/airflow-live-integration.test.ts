import { describe, expect, it } from 'bun:test'
import { DELETE, GET, POST } from '@/app/api/airflow/[...path]/route'

const BACKEND_URL =
  process.env.PIGINOT_BACKEND_URL ?? process.env.PIGINOT_URL ?? 'http://127.0.0.1:8000'

const isBackendReachable = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/health`)
  .then((res) => res.ok)
  .catch(() => false)

describe.skipIf(!isBackendReachable)(
  'Airflow Next.js API Proxy live integration with backend',
  () => {
    it('proxies GET /health to backend', async () => {
      const req = new Request('http://localhost:3002/api/airflow/health')
      const res = await GET(req, { params: Promise.resolve({ path: ['health'] }) })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.device).toBeDefined()
      expect(data.cuda_available).toBe(true)
    })

    it('proxies GET /models to backend', async () => {
      const req = new Request('http://localhost:3002/api/airflow/models')
      const res = await GET(req, { params: Promise.resolve({ path: ['models'] }) })
      expect(res.status).toBe(200)
      const models = await res.json()
      expect(Array.isArray(models)).toBe(true)
      expect(models.length).toBeGreaterThan(0)
      expect(models.some((m: { run: string }) => m.run === 'final30_lgo_ginot_lr1e-3')).toBe(true)
    })

    it('proxies GET /cases to backend', async () => {
      const req = new Request('http://localhost:3002/api/airflow/cases')
      const res = await GET(req, { params: Promise.resolve({ path: ['cases'] }) })
      expect(res.status).toBe(200)
      const cases = await res.json()
      expect(Array.isArray(cases)).toBe(true)
      expect(cases.some((c: { case: string }) => c.case === 'B001')).toBe(true)
    })

    it('proxies GET /cases/B001 to backend', async () => {
      const req = new Request('http://localhost:3002/api/airflow/cases/B001')
      const res = await GET(req, { params: Promise.resolve({ path: ['cases', 'B001'] }) })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.case).toBe('B001')
      expect(data.room.max).toEqual([8.8, 6.1, 3.2])
      expect(data.supply_vents_xy.length).toBe(3)
    })
    it('proxies GET /cases/B001/compare to backend', async () => {
      const req = new Request('http://localhost:3002/api/airflow/cases/B001/compare')
      const res = await GET(req, {
        params: Promise.resolve({ path: ['cases', 'B001', 'compare'] }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.case).toBe('B001')
      expect(typeof data.velocity_r2).toBe('number')
      expect(typeof data.T_mae).toBe('number')
    }, 30000)

    it('proxies GET /cases/B001/report to backend', async () => {
      const req = new Request(
        'http://localhost:3002/api/airflow/cases/B001/report?height=1.1&spacing=0.25',
      )
      const res = await GET(req, { params: Promise.resolve({ path: ['cases', 'B001', 'report'] }) })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.case).toBe('B001')
      expect(data.report_id).toBeDefined()
      expect(data.kpis.composite_score).toBeGreaterThan(0)
      expect(Array.isArray(data.compliance_checks)).toBe(true)
    }, 30000)

    it('proxies POST /predict to backend', async () => {
      const req = new Request('http://localhost:3002/api/airflow/predict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          case: 'B001',
          points: [[2.0, 1.5, 1.1]],
        }),
      })
      const res = await POST(req, { params: Promise.resolve({ path: ['predict'] }) })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.case).toBe('B001')
      expect(data.u.length).toBe(1)
      expect(data.v.length).toBe(1)
      expect(data.w.length).toBe(1)
      expect(data.T.length).toBe(1)
    })

    it('proxies POST /slice to backend', async () => {
      const req = new Request('http://localhost:3002/api/airflow/slice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          case: 'B001',
          axis: 'z',
          value: 1.1,
          spacing: 0.5,
        }),
      })
      const res = await POST(req, { params: Promise.resolve({ path: ['slice'] }) })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.case).toBe('B001')
      expect(data.axis).toBe('z')
      expect(Array.isArray(data.u)).toBe(true)
    })

    it('proxies POST /cases/B001/load and DELETE /cases/B001/load to backend', async () => {
      const postReq = new Request('http://localhost:3002/api/airflow/cases/B001/load', {
        method: 'POST',
      })
      const postRes = await POST(postReq, {
        params: Promise.resolve({ path: ['cases', 'B001', 'load'] }),
      })
      expect(postRes.status).toBe(200)
      const postData = await postRes.json()
      expect(postData.case).toBe('B001')
      expect(typeof postData.setup_s).toBe('number')

      const delReq = new Request('http://localhost:3002/api/airflow/cases/B001/load', {
        method: 'DELETE',
      })
      const delRes = await DELETE(delReq, {
        params: Promise.resolve({ path: ['cases', 'B001', 'load'] }),
      })
      expect(delRes.status).toBe(200)
      const delData = await delRes.json()
      expect(delData.device).toBeDefined()
    })
  },
)
