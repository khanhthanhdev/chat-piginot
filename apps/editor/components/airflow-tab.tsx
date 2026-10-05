'use client'

import { Activity, LoaderCircle, Wind } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

type CaseSummary = { case: string; set: string }
type AirflowModel = {
  run: string
  architecture?: string | null
  recommended: boolean
  default: boolean
}
type Point2 = [number, number]
type CaseDetails = {
  room: { min: [number, number, number]; max: [number, number, number] }
  supply_vents_xy: Point2[]
  return_vents_xy: Point2[]
}
type SliceResult = {
  run: string
  case: string
  value: number
  shape: [number, number]
  axes: { x: number[]; y: number[] }
  u: number[][]
  v: number[][]
  w: number[][]
  T: number[][]
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; detail?: string }
    | T
    | null
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && ('error' in payload || 'detail' in payload)
        ? (payload.error ?? payload.detail)
        : undefined
    throw new Error(message || `Airflow request failed (${response.status})`)
  }
  return payload as T
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function heatColor(value: number, minimum: number, maximum: number) {
  const amount = maximum > minimum ? (value - minimum) / (maximum - minimum) : 0.5
  return `hsl(${240 - Math.max(0, Math.min(1, amount)) * 240} 82% 52%)`
}

function FieldMap({
  details,
  result,
  metric,
}: {
  details: CaseDetails
  result: SliceResult
  metric: 'speed' | 'temperature'
}) {
  const [width, height] = [
    details.room.max[0] - details.room.min[0],
    details.room.max[1] - details.room.min[1],
  ]
  const values = useMemo(() => {
    if (metric === 'temperature') return result.T
    return result.u.map((row, rowIndex) =>
      row.map((u, columnIndex) =>
        Math.hypot(
          u,
          result.v[rowIndex]?.[columnIndex] ?? 0,
          result.w[rowIndex]?.[columnIndex] ?? 0,
        ),
      ),
    )
  }, [metric, result])
  const flatValues = values.flat()
  const minimum = Math.min(...flatValues)
  const maximum = Math.max(...flatValues)
  const cellWidth = result.axes.x.length > 1 ? result.axes.x[1]! - result.axes.x[0]! : width
  const cellHeight = result.axes.y.length > 1 ? result.axes.y[1]! - result.axes.y[0]! : height
  const [rows, columns] = result.shape

  return (
    <div>
      <svg
        aria-label={`${metric === 'speed' ? 'Air speed' : 'Temperature'} at ${result.value} metres for ${result.case}`}
        className="block w-full overflow-hidden rounded-md border border-border bg-slate-950"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {Array.from({ length: rows }, (_, rowIndex) =>
          Array.from({ length: columns }, (_, columnIndex) => {
            const value = values[rowIndex]?.[columnIndex]
            const x = result.axes.x[rowIndex]
            const y = result.axes.y[columnIndex]
            if (value === undefined || x === undefined || y === undefined) return null
            return (
              <rect
                fill={heatColor(value, minimum, maximum)}
                height={cellHeight}
                key={`${rowIndex}-${columnIndex}`}
                opacity="0.88"
                width={cellWidth}
                x={x - details.room.min[0] - cellWidth / 2}
                y={height - (y - details.room.min[1]) - cellHeight / 2}
              />
            )
          }),
        )}
        {details.supply_vents_xy.map(([x, y], index) => (
          <circle
            cx={x - details.room.min[0]}
            cy={height - (y - details.room.min[1])}
            fill="#0284c7"
            key={`supply-${index}`}
            r={0.13}
            stroke="white"
            strokeWidth="0.035"
          />
        ))}
        {details.return_vents_xy.map(([x, y], index) => (
          <circle
            cx={x - details.room.min[0]}
            cy={height - (y - details.room.min[1])}
            fill="#f97316"
            key={`return-${index}`}
            r={0.13}
            stroke="white"
            strokeWidth="0.035"
          />
        ))}
      </svg>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{minimum.toFixed(2)}</span>
        <span
          aria-hidden="true"
          className="h-2 flex-1 rounded-full"
          style={{ background: 'linear-gradient(90deg, hsl(240 82% 52%), hsl(0 82% 52%))' }}
        />
        <span>
          {maximum.toFixed(2)} {metric === 'speed' ? 'm/s' : 'K'}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-sky-600" /> Supply vents
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-orange-500" /> Return vents
        </span>
      </div>
    </div>
  )
}

export function AirflowTab() {
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [models, setModels] = useState<AirflowModel[]>([])
  const [selectedCase, setSelectedCase] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [details, setDetails] = useState<CaseDetails | null>(null)
  const [result, setResult] = useState<SliceResult | null>(null)
  const [sliceHeight, setSliceHeight] = useState('1.1')
  const [spacing, setSpacing] = useState('0.2')
  const [metric, setMetric] = useState<'speed' | 'temperature'>('speed')
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [predicting, setPredicting] = useState(false)
  const [error, setError] = useState('')
  const predictionController = useRef<AbortController | null>(null)

  const clearPrediction = useCallback(() => {
    predictionController.current?.abort()
    predictionController.current = null
    setPredicting(false)
    setResult(null)
    setError('')
  }, [])

  useEffect(
    () => () => {
      predictionController.current?.abort()
    },
    [],
  )

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetchJson<CaseSummary[]>('/api/airflow/cases', { signal: controller.signal }),
      fetchJson<AirflowModel[]>('/api/airflow/models', { signal: controller.signal }),
    ])
      .then(([availableCases, availableModels]) => {
        setCases(availableCases)
        setModels(availableModels)
        setSelectedCase(availableCases[0]?.case ?? '')
        setSelectedModel(
          availableModels.find(({ default: isDefault }) => isDefault)?.run ??
            availableModels[0]?.run ??
            '',
        )
        setError('')
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCatalog(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selectedCase) return
    const controller = new AbortController()
    clearPrediction()
    setLoadingDetails(true)
    setDetails(null)
    fetchJson<CaseDetails>(`/api/airflow/cases/${encodeURIComponent(selectedCase)}`, {
      signal: controller.signal,
    })
      .then(setDetails)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetails(false)
      })
    return () => controller.abort()
  }, [clearPrediction, selectedCase])

  const requestSlice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedCase || !selectedModel) return
    predictionController.current?.abort()
    const controller = new AbortController()
    predictionController.current = controller
    setPredicting(true)
    setError('')
    setResult(null)
    try {
      const slice = await fetchJson<SliceResult>('/api/airflow/slice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          case: selectedCase,
          run: selectedModel,
          axis: 'z',
          value: Number(sliceHeight),
          spacing: Number(spacing),
        }),
        signal: controller.signal,
      })
      if (!controller.signal.aborted) setResult(slice)
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason))
    } finally {
      if (predictionController.current === controller) {
        predictionController.current = null
        setPredicting(false)
      }
    }
  }

  const roomWidth = details ? details.room.max[0] - details.room.min[0] : 0
  const roomDepth = details ? details.room.max[1] - details.room.min[1] : 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-border border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Wind aria-hidden="true" className="h-4 w-4 text-sky-600" />
          <h2 className="font-semibold text-sm">Airflow analysis</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Explore predictions for available room and vent-layout cases.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {loadingCatalog ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading airflow cases…
          </div>
        ) : cases.length === 0 || models.length === 0 ? (
          <p className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
            The airflow service did not return any cases or models.
          </p>
        ) : (
          <>
            <label className="block space-y-1.5 text-xs font-medium">
              Room and vent layout
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                onChange={(event) => setSelectedCase(event.target.value)}
                value={selectedCase}
              >
                {cases.map(({ case: caseId, set }) => (
                  <option key={caseId} value={caseId}>
                    {caseId} · {set}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1.5 text-xs font-medium">
              Prediction model
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                onChange={(event) => {
                  clearPrediction()
                  setSelectedModel(event.target.value)
                }}
                value={selectedModel}
              >
                {models.map(({ run, architecture, recommended }) => (
                  <option key={run} value={run}>
                    {run}
                    {architecture ? ` · ${architecture}` : ''}
                    {recommended ? ' · recommended' : ''}
                  </option>
                ))}
              </select>
            </label>

            <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs">
              <p className="font-medium">Supported room</p>
              {loadingDetails ? (
                <p className="mt-1 text-muted-foreground">Loading room dimensions and vents…</p>
              ) : details ? (
                <>
                  <p className="mt-1 text-muted-foreground">
                    {roomWidth.toFixed(2)} × {roomDepth.toFixed(2)} ×{' '}
                    {(details.room.max[2] - details.room.min[2]).toFixed(2)} m
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {details.supply_vents_xy.length} supply · {details.return_vents_xy.length}{' '}
                    return vents
                  </p>
                </>
              ) : null}
            </div>

            <form className="space-y-3" onSubmit={requestSlice}>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1.5 text-xs font-medium">
                  Horizontal slice height (m)
                  <input
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                    max={details?.room.max[2] ?? 3.2}
                    min={details?.room.min[2] ?? 0}
                    onChange={(event) => {
                      clearPrediction()
                      setSliceHeight(event.target.value)
                    }}
                    required
                    step="0.05"
                    type="number"
                    value={sliceHeight}
                  />
                </label>
                <label className="space-y-1.5 text-xs font-medium">
                  Grid spacing (m)
                  <input
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                    max="2"
                    min="0.05"
                    onChange={(event) => {
                      clearPrediction()
                      setSpacing(event.target.value)
                    }}
                    required
                    step="0.05"
                    type="number"
                    value={spacing}
                  />
                </label>
              </div>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2.5 font-medium text-primary-foreground text-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={predicting || !details || !selectedModel}
                type="submit"
              >
                {predicting ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Activity className="h-4 w-4" />
                )}
                {predicting ? 'Predicting…' : 'Predict airflow slice'}
              </button>
            </form>

            {details && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium text-sm">Predicted field</h3>
                  <select
                    aria-label="Displayed airflow field"
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                    onChange={(event) => setMetric(event.target.value as 'speed' | 'temperature')}
                    value={metric}
                  >
                    <option value="speed">Speed (m/s)</option>
                    <option value="temperature">Temperature (K)</option>
                  </select>
                </div>
                {result ? (
                  <>
                    <FieldMap details={details} metric={metric} result={result} />
                    <p className="text-[11px] text-muted-foreground">
                      {result.case} · {result.run} · z = {result.value.toFixed(2)} m
                    </p>
                  </>
                ) : (
                  <div className="flex aspect-[1.45] items-center justify-center rounded-md border border-dashed border-border px-5 text-center text-xs text-muted-foreground">
                    Run a prediction to view the horizontal airflow field. Vent markers show supply
                    and return positions.
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {error && (
          <p
            aria-live="polite"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <p className="border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Predictions are limited to the backend’s precomputed room and vent layouts. This panel
          does not analyze the edited scene or generate new HVAC layouts.
        </p>
      </div>
    </div>
  )
}
