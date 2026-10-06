'use client'

import { Activity, FileText, Layers, LoaderCircle, Sliders, Sparkles, Wind } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HvacReportModal } from '@/components/hvac-report-modal'
import {
  type CandidateResult,
  type CaseDetails,
  type HvacReportData,
  type SliceResult,
  useAirflowStore,
} from '@/lib/airflow-store'

type CaseSummary = { case: string; set: string }
type AirflowModel = {
  run: string
  architecture?: string | null
  recommended: boolean
  default: boolean
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = 440
    const h = Math.round((440 * height) / width)
    canvas.width = w
    canvas.height = h
    ctx.fillStyle = '#020617'
    ctx.fillRect(0, 0, w, h)

    const scaleX = w / width
    const scaleY = h / height

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const val = values[r]?.[c]
        const x = result.axes.x[r]
        const y = result.axes.y[c]
        if (val === undefined || x === undefined || y === undefined) continue
        ctx.fillStyle = heatColor(val, minimum, maximum)
        const rx = (x - details.room.min[0] - cellWidth / 2) * scaleX
        const ry = (height - (y - details.room.min[1]) - cellHeight / 2) * scaleY
        ctx.fillRect(rx, ry, cellWidth * scaleX + 0.5, cellHeight * scaleY + 0.5)
      }
    }

    for (const [vx, vy] of details.supply_vents_xy) {
      const cx = (vx - details.room.min[0]) * scaleX
      const cy = (height - (vy - details.room.min[1])) * scaleY
      ctx.beginPath()
      ctx.arc(cx, cy, 6, 0, Math.PI * 2)
      ctx.fillStyle = '#0284c7'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    for (const [vx, vy] of details.return_vents_xy) {
      const cx = (vx - details.room.min[0]) * scaleX
      const cy = (height - (vy - details.room.min[1])) * scaleY
      ctx.beginPath()
      ctx.arc(cx, cy, 6, 0, Math.PI * 2)
      ctx.fillStyle = '#f97316'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [
    cellHeight,
    cellWidth,
    columns,
    details,
    height,
    maximum,
    minimum,
    result.axes.x,
    result.axes.y,
    rows,
    values,
    width,
  ])

  return (
    <div>
      <canvas id="airflow-slice-canvas" ref={canvasRef} style={{ display: 'none' }} />
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
  const selectedCase = useAirflowStore((s) => s.selectedCase)
  const setSelectedCase = useAirflowStore((s) => s.setSelectedCase)
  const selectedModel = useAirflowStore((s) => s.selectedModel)
  const setSelectedModel = useAirflowStore((s) => s.setSelectedModel)
  const details = useAirflowStore((s) => s.details)
  const setDetails = useAirflowStore((s) => s.setDetails)
  const result = useAirflowStore((s) => s.sliceResult)
  const setResult = useAirflowStore((s) => s.setSliceResult)
  const sliceHeight = useAirflowStore((s) => s.sliceHeight)
  const setSliceHeight = useAirflowStore((s) => s.setSliceHeight)
  const spacing = useAirflowStore((s) => s.spacing)
  const setSpacing = useAirflowStore((s) => s.setSpacing)
  const metric = useAirflowStore((s) => s.metric)
  const setMetric = useAirflowStore((s) => s.setMetric)
  const show3DSlice = useAirflowStore((s) => s.show3DSlice)
  const setShow3DSlice = useAirflowStore((s) => s.setShow3DSlice)
  const sliceOpacity = useAirflowStore((s) => s.sliceOpacity)
  const setSliceOpacity = useAirflowStore((s) => s.setSliceOpacity)
  const optimizerPriority = useAirflowStore((s) => s.optimizerPriority)
  const setOptimizerPriority = useAirflowStore((s) => s.setOptimizerPriority)
  const isOptimizing = useAirflowStore((s) => s.isOptimizing)
  const setIsOptimizing = useAirflowStore((s) => s.setIsOptimizing)
  const rankedCandidates = useAirflowStore((s) => s.rankedCandidates)
  const setRankedCandidates = useAirflowStore((s) => s.setRankedCandidates)
  const setIsReportModalOpen = useAirflowStore((s) => s.setIsReportModalOpen)
  const setReportData = useAirflowStore((s) => s.setReportData)
  const isLoadingReport = useAirflowStore((s) => s.isLoadingReport)
  const setIsLoadingReport = useAirflowStore((s) => s.setIsLoadingReport)
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [models, setModels] = useState<AirflowModel[]>([])
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
  }, [setResult])

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
        if (!selectedCase && availableCases[0]?.case) {
          setSelectedCase(availableCases[0].case)
        }
        if (!selectedModel) {
          const defaultModel =
            availableModels.find(({ default: isDefault }) => isDefault)?.run ??
            availableModels[0]?.run ??
            ''
          setSelectedModel(defaultModel)
        }
        setError('')
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCatalog(false)
      })
    return () => controller.abort()
  }, [selectedCase, selectedModel, setSelectedCase, setSelectedModel])

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
  }, [clearPrediction, selectedCase, setDetails])

  const fetchSliceForCase = async (
    targetCase: string,
    targetModel: string,
    heightVal: number,
    spacingVal: number,
  ) => {
    predictionController.current?.abort()
    const controller = new AbortController()
    predictionController.current = controller
    setPredicting(true)
    setError('')
    try {
      const slice = await fetchJson<SliceResult>('/api/airflow/slice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          case: targetCase,
          run: targetModel,
          axis: 'z',
          value: heightVal,
          spacing: spacingVal,
        }),
        signal: controller.signal,
      })
      if (!controller.signal.aborted) {
        setResult(slice)
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(errorMessage(reason))
      }
    } finally {
      if (predictionController.current === controller) {
        predictionController.current = null
        setPredicting(false)
      }
    }
  }

  const requestSlice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedCase || !selectedModel) return
    await fetchSliceForCase(selectedCase, selectedModel, sliceHeight, spacing)
  }

  const runOptimizer = async () => {
    if (!selectedModel) return
    setIsOptimizing(true)
    setError('')
    try {
      const res = await fetchJson<{
        run: string
        height: number
        priority: string
        recommended_case: string | null
        candidates: CandidateResult[]
      }>('/api/airflow/cases/optimize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          run: selectedModel,
          height: sliceHeight,
          spacing: 0.25,
          priority: optimizerPriority,
          limit: 5,
        }),
      })
      setRankedCandidates(res.candidates)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setIsOptimizing(false)
    }
  }

  const applyCandidate = async (candidate: CandidateResult) => {
    setSelectedCase(candidate.case)
    setLoadingDetails(true)
    try {
      const caseDetails = await fetchJson<CaseDetails>(
        `/api/airflow/cases/${encodeURIComponent(candidate.case)}`,
      )
      setDetails(caseDetails)
      await fetchSliceForCase(candidate.case, selectedModel, sliceHeight, spacing)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoadingDetails(false)
    }
  }

  const openCaseReport = useCallback(
    async (caseId: string) => {
      if (!caseId) return
      setIsLoadingReport(true)
      setError('')
      try {
        const query = new URLSearchParams({
          run: selectedModel,
          height: String(sliceHeight),
          spacing: String(spacing),
          priority: optimizerPriority,
        })
        const report = await fetchJson<HvacReportData>(
          `/api/airflow/cases/${encodeURIComponent(caseId)}/report?${query.toString()}`,
        )
        setReportData(report)
        setIsReportModalOpen(true)
      } catch (reason) {
        setError(errorMessage(reason))
      } finally {
        setIsLoadingReport(false)
      }
    },
    [
      selectedModel,
      sliceHeight,
      spacing,
      optimizerPriority,
      setIsLoadingReport,
      setReportData,
      setIsReportModalOpen,
    ],
  )
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
          Explore predictions and optimize diffuser layouts across precomputed CFD cases.
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
            {/* Case and Model Selection */}
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
                  <div className="mt-2 pt-2 border-t border-border/60 flex justify-end">
                    <button
                      type="button"
                      disabled={isLoadingReport}
                      onClick={() => openCaseReport(selectedCase)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 hover:text-sky-500 cursor-pointer disabled:opacity-50"
                    >
                      <FileText className="h-3 w-3" />
                      {isLoadingReport ? 'Generating report…' : 'View Engineering Report'}
                    </button>
                  </div>
                </>
              ) : null}
            </div>

            {/* 3D Viewport Controls Card */}
            <div className="space-y-3 rounded-md border border-border bg-card p-3 shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-primary" />
                  <span className="font-medium text-xs">Render slice in 3D scene</span>
                </div>
                <input
                  checked={show3DSlice}
                  className="h-4 w-4 rounded border-input accent-primary"
                  onChange={(e) => setShow3DSlice(e.target.checked)}
                  type="checkbox"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-muted-foreground text-xs">
                  <span className="flex items-center gap-1">
                    <Sliders className="h-3 w-3" />
                    3D Plane Opacity
                  </span>
                  <span>{Math.round(sliceOpacity * 100)}%</span>
                </div>
                <input
                  className="w-full accent-primary"
                  disabled={!show3DSlice}
                  max="1.0"
                  min="0.2"
                  onChange={(e) => setSliceOpacity(Number(e.target.value))}
                  step="0.05"
                  type="range"
                  value={sliceOpacity}
                />
              </div>
            </div>

            {/* HVAC Layout Optimizer Card */}
            <div className="space-y-3 rounded-md border border-sky-500/30 bg-sky-950/10 p-3 shadow-xs">
              <div className="flex items-center gap-1.5 text-sky-600">
                <Sparkles className="h-4 w-4" />
                <h3 className="font-semibold text-xs">
                  Automated Layout Optimizer (LGO Neural Operator)
                </h3>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Scores ceiling diffuser configurations for ASHRAE 55 occupied-plane comfort:
                air-sweep coverage, dead zones, and draft risks.
              </p>

              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Optimization Priority
                  <select
                    className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-normal"
                    onChange={(e) =>
                      setOptimizerPriority(
                        e.target.value as 'balanced' | 'minimize_draft' | 'eliminate_dead_zones',
                      )
                    }
                    value={optimizerPriority}
                  >
                    <option value="balanced">Balanced Comfort</option>
                    <option value="minimize_draft">Minimize Cold Drafts</option>
                    <option value="eliminate_dead_zones">Eliminate Dead Zones</option>
                  </select>
                </label>
              </div>

              <button
                className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-600 px-3 py-2 font-medium text-white text-xs hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isOptimizing || !selectedModel}
                onClick={runOptimizer}
                type="button"
              >
                {isOptimizing ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {isOptimizing ? 'Analyzing candidates…' : 'Run HVAC Layout Optimizer'}
              </button>

              {rankedCandidates.length > 0 && (
                <button
                  type="button"
                  disabled={isLoadingReport}
                  onClick={() => openCaseReport(selectedCase || rankedCandidates[0]?.case || '')}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isLoadingReport ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  {isLoadingReport ? 'Compiling Report…' : 'Generate ASHRAE 55 Compliance Report'}
                </button>
              )}

              {rankedCandidates.length > 0 && (
                <div className="mt-3 space-y-2 border-border/60 border-t pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Ranked Layout Candidates
                    </span>
                    <button
                      type="button"
                      disabled={isLoadingReport}
                      onClick={() =>
                        openCaseReport(selectedCase || rankedCandidates[0]?.case || '')
                      }
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-600 hover:text-sky-500 cursor-pointer disabled:opacity-50"
                    >
                      <FileText className="h-3 w-3" />
                      {isLoadingReport ? 'Loading…' : 'Full Report'}
                    </button>
                  </div>
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {rankedCandidates.map((candidate, idx) => (
                      <div
                        className={`rounded-md border p-2 text-xs transition-colors ${
                          selectedCase === candidate.case
                            ? 'border-sky-500 bg-sky-500/10'
                            : 'border-border bg-card'
                        }`}
                        key={candidate.case}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                idx === 0
                                  ? 'bg-sky-500 text-white'
                                  : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {idx === 0 ? '#1 Recommended' : `#${idx + 1}`}
                            </span>
                            <span className="font-medium">{candidate.case}</span>
                          </div>
                          <span className="font-semibold text-sky-600 dark:text-sky-400">
                            Score: {candidate.score.toFixed(1)} / 100
                          </span>
                        </div>

                        <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                          <span className="rounded bg-muted px-1.5 py-0.5">
                            Sweep: {(candidate.kpis.air_sweep_coverage * 100).toFixed(0)}%
                          </span>
                          <span className="rounded bg-muted px-1.5 py-0.5">
                            Dead Zone: {(candidate.kpis.dead_zone_ratio * 100).toFixed(0)}%
                          </span>
                          <span className="rounded bg-muted px-1.5 py-0.5">
                            Draft Risk: {(candidate.kpis.draft_risk_ratio * 100).toFixed(0)}%
                          </span>
                        </div>

                        <div className="mt-2 flex items-center justify-end gap-1.5">
                          <button
                            className="rounded border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                            onClick={() => openCaseReport(candidate.case)}
                            type="button"
                            title="View and export compliance report for this layout"
                          >
                            Report
                          </button>
                          <button
                            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                              selectedCase === candidate.case
                                ? 'bg-sky-600 text-white'
                                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                            }`}
                            onClick={() => applyCandidate(candidate)}
                            type="button"
                          >
                            {selectedCase === candidate.case ? 'Active Layout' : 'Apply Layout'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Slice Query Form */}
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
                      setSliceHeight(Number(event.target.value))
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
                      setSpacing(Number(event.target.value))
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
          Predictions are powered by the LGO neural operator surrogate model across CFD room and
          vent layouts.
        </p>
      </div>
      <HvacReportModal />
    </div>
  )
}
