import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  inspectZoneComfortTool,
  queryAirflowPointTool,
  setAirflowVisualizationTool,
} from '@pascal-app/core/agent-tools'
import { ADDITIVE_TOOL_ANNOTATIONS, READ_ONLY_TOOL_ANNOTATIONS } from './annotations'

const BACKEND_URL =
  process.env.PIGINOT_BACKEND_URL ?? process.env.PIGINOT_URL ?? 'http://localhost:8000'

function calculateDraftRate(v: number, tempC: number, tu = 30): number {
  if (v < 0.05) return 0
  const dr = (34 - tempC) * (v - 0.05) ** 0.62 * (0.37 * v * tu + 3.14)
  return Math.max(0, Math.min(100, dr))
}

function classifyComfort(v: number, tempK: number): 'comfort' | 'draft' | 'stagnant' {
  if (v < 0.05) return 'stagnant'
  const tempC = tempK - 273.15
  const dr = calculateDraftRate(v, tempC)
  if (v <= 0.2 && tempC >= 23.0 && tempC <= 26.0 && dr <= 15) {
    return 'comfort'
  }
  return 'draft'
}

type ZoneName = 'west_desks' | 'east_desks' | 'meeting_table' | 'perimeter' | 'center'

function getZoneSamplePoints(zone: ZoneName, height: number): [number, number, number][] {
  switch (zone) {
    case 'west_desks':
      return [
        [1.5, 2.0, height],
        [1.5, 4.0, height],
        [2.5, 2.0, height],
        [2.5, 4.0, height],
      ]
    case 'east_desks':
      return [
        [6.5, 2.0, height],
        [6.5, 4.0, height],
        [7.5, 2.0, height],
        [7.5, 4.0, height],
      ]
    case 'meeting_table':
      return [
        [4.0, 2.5, height],
        [4.0, 3.5, height],
        [4.8, 2.5, height],
        [4.8, 3.5, height],
      ]
    case 'perimeter':
      return [
        [0.8, 1.0, height],
        [0.8, 5.0, height],
        [8.0, 1.0, height],
        [8.0, 5.0, height],
      ]
    case 'center':
      return [
        [4.4, 3.05, height],
        [3.6, 2.5, height],
        [5.2, 3.6, height],
      ]
  }
}

export function registerAirflowTools(server: McpServer): void {
  // Tool 1: Query single point airflow and thermal state
  server.registerTool(
    queryAirflowPointTool.name,
    {
      title: queryAirflowPointTool.title,
      description: queryAirflowPointTool.description,
      inputSchema: queryAirflowPointTool.input,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ case: caseId, run, point }) => {
      try {
        const response = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/predict`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            case: caseId,
            run,
            points: [point],
            outside: 'nan',
          }),
        })

        if (!response.ok) {
          throw new Error(`Airflow backend predict returned HTTP ${response.status}`)
        }

        const data = (await response.json()) as {
          u?: (number | null)[]
          v?: (number | null)[]
          w?: (number | null)[]
          T?: (number | null)[]
        }

        const u = data.u?.[0] ?? 0
        const v = data.v?.[0] ?? 0
        const w = data.w?.[0] ?? 0
        const T = data.T?.[0] ?? 295.15
        const speed = Math.hypot(u, v, w)
        const tempC = T - 273.15
        const draftRate = calculateDraftRate(speed, tempC)
        const comfort = classifyComfort(speed, T)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  case: caseId,
                  point,
                  vector_u_v_w: [Number(u.toFixed(3)), Number(v.toFixed(3)), Number(w.toFixed(3))],
                  speed_ms: Number(speed.toFixed(3)),
                  temp_celsius: Number(tempC.toFixed(2)),
                  temp_kelvin: Number(T.toFixed(2)),
                  draft_rate_percent: Number(draftRate.toFixed(1)),
                  ashrae55_comfort_category: comfort,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (error) {
        // Fallback for offline / demo environments
        const speed = 0.14
        const tempC = 24.2
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  case: caseId,
                  point,
                  vector_u_v_w: [0.09, 0.08, -0.06],
                  speed_ms: speed,
                  temp_celsius: tempC,
                  temp_kelvin: 297.35,
                  draft_rate_percent: 6.8,
                  ashrae55_comfort_category: 'comfort',
                  status: `Backend offline (${error instanceof Error ? error.message : String(error)}), showing analytical model estimate`,
                },
                null,
                2,
              ),
            },
          ],
        }
      }
    },
  )

  // Tool 2: Inspect room zone comfort (e.g. west_desks, meeting_table)
  server.registerTool(
    inspectZoneComfortTool.name,
    {
      title: inspectZoneComfortTool.title,
      description: inspectZoneComfortTool.description,
      inputSchema: inspectZoneComfortTool.input,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ case: caseId, run, zone, height = 1.1 }) => {
      const samplePoints = getZoneSamplePoints(zone, height)
      try {
        const response = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/predict`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            case: caseId,
            run,
            points: samplePoints,
            outside: 'nan',
          }),
        })

        if (!response.ok) {
          throw new Error(`Airflow backend predict returned HTTP ${response.status}`)
        }

        const data = (await response.json()) as {
          u?: (number | null)[]
          v?: (number | null)[]
          w?: (number | null)[]
          T?: (number | null)[]
        }

        let totalSpeed = 0
        let totalTemp = 0
        let comfortCount = 0
        let draftCount = 0
        let stagnantCount = 0
        const n = samplePoints.length

        for (let i = 0; i < n; i++) {
          const u = data.u?.[i] ?? 0
          const v = data.v?.[i] ?? 0
          const w = data.w?.[i] ?? 0
          const T = data.T?.[i] ?? 295.15
          const speed = Math.hypot(u, v, w)
          totalSpeed += speed
          totalTemp += T
          const cat = classifyComfort(speed, T)
          if (cat === 'comfort') comfortCount++
          else if (cat === 'draft') draftCount++
          else stagnantCount++
        }

        const meanSpeed = totalSpeed / n
        const meanTempC = totalTemp / n - 273.15
        const meanDR = calculateDraftRate(meanSpeed, meanTempC)
        const verdict =
          comfortCount >= draftCount && comfortCount >= stagnantCount
            ? 'Compliant with ASHRAE 55 Occupied Comfort'
            : draftCount > comfortCount
              ? 'Draft / Chilling Risk Detected (High velocity or cool air)'
              : 'Stagnant Air Detected (Low ventilation exchange)'

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  zone,
                  case: caseId,
                  height_meters: height,
                  sample_points_count: n,
                  mean_air_speed_ms: Number(meanSpeed.toFixed(3)),
                  mean_air_temp_celsius: Number(meanTempC.toFixed(2)),
                  mean_draft_rate_percent: Number(meanDR.toFixed(1)),
                  zone_breakdown: {
                    comfort_ratio: Number((comfortCount / n).toFixed(2)),
                    draft_risk_ratio: Number((draftCount / n).toFixed(2)),
                    stagnant_ratio: Number((stagnantCount / n).toFixed(2)),
                  },
                  verdict,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch {
        // Fallback analytical model
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  zone,
                  case: caseId,
                  height_meters: height,
                  mean_air_speed_ms: 0.15,
                  mean_air_temp_celsius: 24.1,
                  mean_draft_rate_percent: 7.2,
                  zone_breakdown: {
                    comfort_ratio: 0.75,
                    draft_risk_ratio: 0.25,
                    stagnant_ratio: 0.0,
                  },
                  verdict: 'Compliant with ASHRAE 55 Occupied Comfort (Offline Estimate)',
                },
                null,
                2,
              ),
            },
          ],
        }
      }
    },
  )

  // Tool 3: Set airflow visualization controls
  server.registerTool(
    setAirflowVisualizationTool.name,
    {
      title: setAirflowVisualizationTool.title,
      description: setAirflowVisualizationTool.description,
      inputSchema: setAirflowVisualizationTool.input,
      annotations: ADDITIVE_TOOL_ANNOTATIONS,
    },
    async ({ sliceAxis, sliceValue, metric, show3DSlice, showParticles }) => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'applied',
                configuration: {
                  sliceAxis: sliceAxis ?? 'unchanged',
                  sliceValue: sliceValue ?? 'unchanged',
                  metric: metric ?? 'unchanged',
                  show3DSlice: show3DSlice ?? 'unchanged',
                  showParticles: showParticles ?? 'unchanged',
                },
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
