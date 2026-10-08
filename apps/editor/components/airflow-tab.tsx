'use client'

import {
  Activity,
  ArrowRightLeft,
  CheckCircle2,
  Crosshair,
  FileText,
  Layers,
  LoaderCircle,
  MapPin,
  Sliders,
  Sparkles,
  Trash2,
  Wind,
} from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HvacReportModal } from '@/components/hvac-report-modal'
import { classifyComfort, comfortRgb, coolToWarmRgb, turboRgb } from '@/lib/airflow-math'
import {
  type CandidateResult,
  type CaseDetails,
  type ComfortMetric,
  type HvacReportData,
  type SliceAxis,
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
  metric: ComfortMetric
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

        if (metric === 'comfort') {
          const u = result.u[r]?.[c] ?? 0
          const v = result.v[r]?.[c] ?? 0
          const w = result.w[r]?.[c] ?? 0
          const speed = Math.hypot(u, v, w)
          const tempK = result.T[r]?.[c] ?? 295.15
          const [cr, cg, cb] = comfortRgb(classifyComfort(speed, tempK))
          ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`
        } else if (metric === 'temperature') {
          const norm = maximum > minimum ? (val - minimum) / (maximum - minimum) : 0.5
          const [cr, cg, cb] = coolToWarmRgb(norm)
          ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`
        } else {
          const norm = maximum > minimum ? (val - minimum) / (maximum - minimum) : 0.5
          const [cr, cg, cb] = turboRgb(norm)
          ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`
        }

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
    metric,
    minimum,
    result,
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

            let rectFill = heatColor(value, minimum, maximum)
            if (metric === 'comfort') {
              const u = result.u[rowIndex]?.[columnIndex] ?? 0
              const v = result.v[rowIndex]?.[columnIndex] ?? 0
              const w = result.w[rowIndex]?.[columnIndex] ?? 0
              const speed = Math.hypot(u, v, w)
              const tempK = result.T[rowIndex]?.[columnIndex] ?? 295.15
              const [cr, cg, cb] = comfortRgb(classifyComfort(speed, tempK))
              rectFill = `rgb(${cr}, ${cg}, ${cb})`
            } else if (metric === 'temperature') {
              const norm = maximum > minimum ? (value - minimum) / (maximum - minimum) : 0.5
              const [cr, cg, cb] = coolToWarmRgb(norm)
              rectFill = `rgb(${cr}, ${cg}, ${cb})`
            }

            return (
              <rect
                fill={rectFill}
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
      {metric === 'comfort' ? (
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" /> Comfort (ASHRAE 55)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-500" /> Draft
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" /> Stagnant
          </span>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>{minimum.toFixed(2)}</span>
          <span
            aria-hidden="true"
            className="h-2 flex-1 rounded-full"
            style={{
              background:
                metric === 'temperature'
                  ? 'linear-gradient(90deg, #3b82f6, #ef4444)'
                  : 'linear-gradient(90deg, hsl(240 82% 52%), hsl(0 82% 52%))',
            }}
          />
          <span>
            {maximum.toFixed(2)} {metric === 'speed' ? 'm/s' : 'K'}
          </span>
        </div>
      )}
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
function LiveProbeCard() {
  const probePoint = useAirflowStore((s) => s.probePoint)
  const isProbingActive = useAirflowStore((s) => s.isProbingActive)

  if (!probePoint || !isProbingActive) return null

  return (
    <div className="rounded border border-emerald-500/30 bg-emerald-950/20 p-2 text-xs">
      <div className="flex items-center justify-between font-medium">
        <span className="text-emerald-400">Live Probe:</span>
        <span className="font-mono">
          {probePoint.velocity.toFixed(2)} m/s · {probePoint.tempC.toFixed(1)}°C
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Pos: [{probePoint.position.map((v) => v.toFixed(2)).join(', ')}]</span>
        <span
          className={`capitalize font-semibold ${
            probePoint.comfortCategory === 'comfort'
              ? 'text-emerald-400'
              : probePoint.comfortCategory === 'draft'
                ? 'text-blue-400'
                : 'text-amber-400'
          }`}
        >
          {probePoint.comfortCategory}
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
  const sliceAxis = useAirflowStore((s) => s.sliceAxis)
  const setSliceAxis = useAirflowStore((s) => s.setSliceAxis)
  const sliceValue = useAirflowStore((s) => s.sliceValue)
  const setSliceValue = useAirflowStore((s) => s.setSliceValue)
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
  const showParticles = useAirflowStore((s) => s.showParticles)
  const setShowParticles = useAirflowStore((s) => s.setShowParticles)
  const particleSpeed = useAirflowStore((s) => s.particleSpeed)
  const setParticleSpeed = useAirflowStore((s) => s.setParticleSpeed)
  const isProbingActive = useAirflowStore((s) => s.isProbingActive)
  const setIsProbingActive = useAirflowStore((s) => s.setIsProbingActive)
  const virtualSensors = useAirflowStore((s) => s.virtualSensors)
  const removeVirtualSensor = useAirflowStore((s) => s.removeVirtualSensor)
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
  const isCompareActive = useAirflowStore((s) => s.isCompareActive)
  const setIsCompareActive = useAirflowStore((s) => s.setIsCompareActive)
  const compareCase = useAirflowStore((s) => s.compareCase)
  const setCompareCase = useAirflowStore((s) => s.setCompareCase)
  const compareSliceResult = useAirflowStore((s) => s.compareSliceResult)
  const setCompareSliceResult = useAirflowStore((s) => s.setCompareSliceResult)
  const compareMetrics = useAirflowStore((s) => s.compareMetrics)
  const setCompareMetrics = useAirflowStore((s) => s.setCompareMetrics)
  const isLoadingCompare = useAirflowStore((s) => s.isLoadingCompare)
  const setIsLoadingCompare = useAirflowStore((s) => s.setIsLoadingCompare)
  const caseWarmStatus = useAirflowStore((s) => s.caseWarmStatus)
  const setCaseWarmStatus = useAirflowStore((s) => s.setCaseWarmStatus)
  const setupTime = useAirflowStore((s) => s.setupTime)
  const setSetupTime = useAirflowStore((s) => s.setSetupTime)
  const [matchedCase, setMatchedCase] = useState<string | null>(null)
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null)
  const loadedCasesRef = useRef<Set<string>>(new Set())
  const comfortStats = useMemo(() => {
    if (!result) return null
    const [rows, columns] = result.shape
    let comfort = 0
    let draft = 0
    let stagnant = 0
    let total = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const u = result.u[r]?.[c] ?? 0
        const v = result.v[r]?.[c] ?? 0
        const w = result.w[r]?.[c] ?? 0
        const speed = Math.hypot(u, v, w)
        const tempK = result.T[r]?.[c] ?? 295.15
        const category = classifyComfort(speed, tempK)
        if (category === 'comfort') comfort++
        else if (category === 'draft') draft++
        else stagnant++
        total++
      }
    }
    if (total === 0) return null
    return {
      comfortPct: Math.round((comfort / total) * 100),
      draftPct: Math.round((draft / total) * 100),
      stagnantPct: Math.round((stagnant / total) * 100),
    }
  }, [result])
  const compareStats = useMemo(() => {
    if (!result || !compareSliceResult) return null
    const meanA = { speed: 0, tempC: 0, comfortCount: 0, total: 0 }
    const meanB = { speed: 0, tempC: 0, comfortCount: 0, total: 0 }
    const [rowsA, colsA] = result.shape
    const [rowsB, colsB] = compareSliceResult.shape

    for (let r = 0; r < rowsA; r++) {
      for (let c = 0; c < colsA; c++) {
        const speed = Math.hypot(
          result.u[r]?.[c] ?? 0,
          result.v[r]?.[c] ?? 0,
          result.w[r]?.[c] ?? 0,
        )
        const tempK = result.T[r]?.[c] ?? 295.15
        meanA.speed += speed
        meanA.tempC += tempK - 273.15
        if (classifyComfort(speed, tempK) === 'comfort') meanA.comfortCount++
        meanA.total++
      }
    }
    for (let r = 0; r < rowsB; r++) {
      for (let c = 0; c < colsB; c++) {
        const speed = Math.hypot(
          compareSliceResult.u[r]?.[c] ?? 0,
          compareSliceResult.v[r]?.[c] ?? 0,
          compareSliceResult.w[r]?.[c] ?? 0,
        )
        const tempK = compareSliceResult.T[r]?.[c] ?? 295.15
        meanB.speed += speed
        meanB.tempC += tempK - 273.15
        if (classifyComfort(speed, tempK) === 'comfort') meanB.comfortCount++
        meanB.total++
      }
    }
    if (meanA.total === 0 || meanB.total === 0) return null
    const avgSpeedA = meanA.speed / meanA.total
    const avgSpeedB = meanB.speed / meanB.total
    const avgTempA = meanA.tempC / meanA.total
    const avgTempB = meanB.tempC / meanB.total
    const comfortA = Math.round((meanA.comfortCount / meanA.total) * 100)
    const comfortB = Math.round((meanB.comfortCount / meanB.total) * 100)

    return {
      avgSpeedA,
      avgSpeedB,
      deltaSpeed: avgSpeedB - avgSpeedA,
      avgTempA,
      avgTempB,
      deltaTemp: avgTempB - avgTempA,
      comfortA,
      comfortB,
      deltaComfort: comfortB - comfortA,
    }
  }, [result, compareSliceResult])

  // Fetch model accuracy metrics comparing prediction to CFD ground truth
  useEffect(() => {
    if (!selectedCase || !selectedModel) {
      setCompareMetrics(null)
      return
    }
    const controller = new AbortController()
    fetchJson<{
      velocity_r2?: number
      velocity_mae?: number
      T_mae?: number
      velocity_R2?: number
      velocity_MAE?: number
      T_MAE_K?: number
    }>(
      `/api/airflow/cases/${encodeURIComponent(selectedCase)}/compare?run=${encodeURIComponent(selectedModel)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        setCompareMetrics({
          velocity_R2: data.velocity_r2 ?? data.velocity_R2,
          velocity_MAE: data.velocity_mae ?? data.velocity_MAE,
          T_MAE_K: data.T_mae ?? data.T_MAE_K,
        })
      })
      .catch(() => {
        setCompareMetrics(null)
      })
    return () => controller.abort()
  }, [selectedCase, selectedModel, setCompareMetrics])
  const loadCaseWarm = useCallback(
    async (caseId: string, modelId = selectedModel) => {
      if (!caseId || !modelId) return
      if (caseWarmStatus[caseId] === 'warm') return
      setCaseWarmStatus(caseId, 'loading')
      try {
        const res = await fetchJson<{ run: string; case: string; setup_s: number }>(
          `/api/airflow/cases/${encodeURIComponent(caseId)}/load?run=${encodeURIComponent(modelId)}`,
          { method: 'POST' },
        )
        setCaseWarmStatus(caseId, 'warm')
        setSetupTime(res.setup_s)
        loadedCasesRef.current.add(caseId)
      } catch {
        setCaseWarmStatus(caseId, 'cold')
      }
    },
    [caseWarmStatus, selectedModel, setCaseWarmStatus, setSetupTime],
  )

  const handleHoverCandidate = useCallback(
    (caseId: string) => {
      clearTimeout(hoverTimerRef.current ?? undefined)
      hoverTimerRef.current = setTimeout(() => {
        loadCaseWarm(caseId)
      }, 200)
    },
    [loadCaseWarm],
  )

  // Optimistic preload on mount or when selectedCase changes
  useEffect(() => {
    if (selectedCase && selectedModel) {
      loadCaseWarm(selectedCase, selectedModel)
    }
  }, [selectedCase, selectedModel, loadCaseWarm])

  // Evict loaded cases on unmount to release GPU memory
  useEffect(() => {
    return () => {
      clearTimeout(hoverTimerRef.current ?? undefined)
      for (const c of loadedCasesRef.current) {
        fetch(`/api/airflow/cases/${encodeURIComponent(c)}/load`, {
          method: 'DELETE',
        }).catch(() => {})
      }
    }
  }, [])

  const runComparison = async () => {
    if (!selectedCase || !compareCase || !selectedModel) return
    setIsLoadingCompare(true)
    setError('')
    try {
      const [sliceA, sliceB] = await Promise.all([
        fetchJson<SliceResult>('/api/airflow/slice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            case: selectedCase,
            run: selectedModel,
            axis: sliceAxis,
            value: sliceValue,
            spacing,
          }),
        }),
        fetchJson<SliceResult>('/api/airflow/slice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            case: compareCase,
            run: selectedModel,
            axis: sliceAxis,
            value: sliceValue,
            spacing,
          }),
        }),
      ])
      setResult({ ...sliceA, axis: sliceAxis })
      setCompareSliceResult({ ...sliceB, axis: sliceAxis })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setIsLoadingCompare(false)
    }
  }
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
    valueVal: number,
    spacingVal: number,
    axisVal: SliceAxis = sliceAxis,
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
          axis: axisVal,
          value: valueVal,
          spacing: spacingVal,
        }),
        signal: controller.signal,
      })
      if (!controller.signal.aborted) {
        setResult({ ...slice, axis: axisVal })
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
    await fetchSliceForCase(selectedCase, selectedModel, sliceValue, spacing, sliceAxis)
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
          target_supply_vents: details?.supply_vents_xy ?? undefined,
          limit: 5,
        }),
      })
      setRankedCandidates(res.candidates)
      if (res.recommended_case) {
        setMatchedCase(res.recommended_case)
      }
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
              <div className="flex items-center justify-between">
                <span>Room and vent layout</span>
                {caseWarmStatus[selectedCase] === 'warm' ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    GPU Warm ({setupTime !== null ? `${setupTime}s` : '<0.1s'})
                  </span>
                ) : caseWarmStatus[selectedCase] === 'loading' ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 border border-amber-500/20">
                    <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                    Loading CFD…
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-400 border border-slate-500/20">
                    Cold
                  </span>
                )}
              </div>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                onChange={(event) => setSelectedCase(event.target.value)}
                value={selectedCase}
              >
                {cases.map(({ case: caseId, set }) => (
                  <option key={caseId} value={caseId}>
                    {caseId} · {set} {caseWarmStatus[caseId] === 'warm' ? '🟢' : ''}
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

            {/* Model Quality & Accuracy Card */}
            {compareMetrics && (
              <div className="space-y-2 rounded-md border border-border bg-card p-2.5 text-xs shadow-xs">
                <div className="flex items-center justify-between font-medium">
                  <span className="flex items-center gap-1.5 text-sky-500">
                    <Sparkles className="h-3.5 w-3.5" />
                    Neural Operator Fidelity (vs CFD)
                  </span>
                  <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-500">
                    R² ={' '}
                    {compareMetrics.velocity_R2 !== undefined
                      ? compareMetrics.velocity_R2.toFixed(3)
                      : 'N/A'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded bg-muted/50 p-1.5 border border-border/40">
                    <span className="text-muted-foreground block text-[10px]">Velocity MAE</span>
                    <span className="font-mono font-medium">
                      {compareMetrics.velocity_MAE !== undefined
                        ? `${compareMetrics.velocity_MAE.toFixed(3)} m/s`
                        : '--'}
                    </span>
                  </div>
                  <div className="rounded bg-muted/50 p-1.5 border border-border/40">
                    <span className="text-muted-foreground block text-[10px]">Temperature MAE</span>
                    <span className="font-mono font-medium">
                      {compareMetrics.T_MAE_K !== undefined
                        ? `${compareMetrics.T_MAE_K.toFixed(3)} K`
                        : '--'}
                    </span>
                  </div>
                </div>
              </div>
            )}

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

              <div className="flex items-center justify-between border-t border-border/50 pt-2.5">
                <div className="flex items-center gap-1.5">
                  <Wind className="h-3.5 w-3.5 text-sky-500" />
                  <span className="font-medium text-xs">
                    3D Airflow Streamlines (800 particles)
                  </span>
                </div>
                <input
                  checked={showParticles}
                  className="h-4 w-4 rounded border-input accent-primary"
                  onChange={(e) => setShowParticles(e.target.checked)}
                  type="checkbox"
                />
              </div>
              {showParticles && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-muted-foreground text-xs">
                    <span>Streamline Speed</span>
                    <span>{particleSpeed.toFixed(1)}x</span>
                  </div>
                  <input
                    className="w-full accent-primary"
                    max="3.0"
                    min="0.5"
                    onChange={(e) => setParticleSpeed(Number(e.target.value))}
                    step="0.1"
                    type="range"
                    value={particleSpeed}
                  />
                </div>
              )}
            </div>

            {/* Virtual Sensor Probing Card */}
            <div className="space-y-3 rounded-md border border-border bg-card p-3 shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Crosshair className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="font-medium text-xs">Virtual Sensor Probing & HUD</span>
                </div>
                <input
                  checked={isProbingActive}
                  className="h-4 w-4 rounded border-input accent-emerald-500"
                  onChange={(e) => setIsProbingActive(e.target.checked)}
                  type="checkbox"
                />
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Hover over the 3D plane to inspect localized velocity & temperature in real time.
                Click to place a permanent virtual sensor.
              </p>

              <LiveProbeCard />

              {virtualSensors.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                    <span>Pinned Sensors ({virtualSensors.length})</span>
                  </div>
                  <div className="max-h-36 space-y-1.5 overflow-y-auto pr-1">
                    {virtualSensors.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between rounded border border-border bg-muted/40 p-1.5 text-xs"
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5 font-medium">
                            <MapPin className="h-3 w-3 text-emerald-500" />
                            <span>{s.name}</span>
                            <span
                              className={`rounded px-1 text-[9px] font-semibold uppercase ${
                                s.comfortCategory === 'comfort'
                                  ? 'bg-emerald-500/20 text-emerald-400'
                                  : s.comfortCategory === 'draft'
                                    ? 'bg-blue-500/20 text-blue-400'
                                    : 'bg-amber-500/20 text-amber-400'
                              }`}
                            >
                              {s.comfortCategory}
                            </span>
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {s.velocity?.toFixed(2) ?? '0.00'} m/s · {s.tempC?.toFixed(1) ?? '--'}°C
                          </div>
                        </div>
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => removeVirtualSensor(s.id)}
                          title="Remove sensor"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* A/B Comparison Mode Card */}
            <div className="space-y-3 rounded-md border border-border bg-card p-3 shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <ArrowRightLeft className="h-3.5 w-3.5 text-indigo-500" />
                  <span className="font-medium text-xs">A/B Layout Comparison Mode</span>
                </div>
                <input
                  checked={isCompareActive}
                  className="h-4 w-4 rounded border-input accent-indigo-500"
                  onChange={(e) => {
                    setIsCompareActive(e.target.checked)
                    if (!compareCase && cases.length > 1) {
                      const other = cases.find((c) => c.case !== selectedCase)
                      if (other) setCompareCase(other.case)
                    }
                  }}
                  type="checkbox"
                />
              </div>

              {isCompareActive && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground text-[10px]">Case A (Current)</span>
                      <div className="font-semibold text-foreground">{selectedCase || 'None'}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[10px]">Case B (Compare)</span>
                      <select
                        className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                        value={compareCase}
                        onChange={(e) => setCompareCase(e.target.value)}
                      >
                        {cases.map((c) => (
                          <option key={c.case} value={c.case}>
                            {c.case} ({c.set})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isLoadingCompare || !selectedCase || !compareCase || !selectedModel}
                    className="flex w-full items-center justify-center gap-2 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    onClick={runComparison}
                  >
                    {isLoadingCompare ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                    )}
                    {isLoadingCompare ? 'Comparing Layouts…' : 'Run A/B Comparison'}
                  </button>

                  {compareStats && (
                    <div className="space-y-2 rounded border border-border bg-muted/30 p-2.5 text-xs">
                      <div className="font-semibold text-[11px] text-muted-foreground">
                        Comparative Results ({selectedCase} vs {compareCase})
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">Mean Air Velocity:</span>
                          <span className="font-mono">
                            {compareStats.avgSpeedA.toFixed(2)} →{' '}
                            {compareStats.avgSpeedB.toFixed(2)} m/s{' '}
                            <span
                              className={`text-[10px] font-semibold ${
                                compareStats.deltaSpeed >= 0 ? 'text-emerald-400' : 'text-amber-400'
                              }`}
                            >
                              ({compareStats.deltaSpeed >= 0 ? '+' : ''}
                              {compareStats.deltaSpeed.toFixed(2)})
                            </span>
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">Mean Air Temp:</span>
                          <span className="font-mono">
                            {compareStats.avgTempA.toFixed(1)}°C →{' '}
                            {compareStats.avgTempB.toFixed(1)}°C{' '}
                            <span className="text-[10px] text-muted-foreground">
                              ({compareStats.deltaTemp >= 0 ? '+' : ''}
                              {compareStats.deltaTemp.toFixed(1)}°C)
                            </span>
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">ASHRAE 55 Comfort:</span>
                          <span className="font-mono font-medium">
                            {compareStats.comfortA}% → {compareStats.comfortB}%{' '}
                            <span
                              className={`text-[10px] font-semibold ${
                                compareStats.deltaComfort >= 0
                                  ? 'text-emerald-400'
                                  : 'text-rose-400'
                              }`}
                            >
                              ({compareStats.deltaComfort >= 0 ? '+' : ''}
                              {compareStats.deltaComfort}%)
                            </span>
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
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

              {matchedCase && (
                <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-950/20 p-2.5 text-xs">
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    <div>
                      <span className="font-semibold">
                        Matched Digital Twin: Case {matchedCase}
                      </span>
                      <p className="text-[10px] text-muted-foreground">
                        Closest physical match to current diffuser layout
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                    onClick={() => setSelectedCase(matchedCase)}
                  >
                    Load Case
                  </button>
                </div>
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
                        onMouseEnter={() => handleHoverCandidate(candidate.case)}
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
                            {caseWarmStatus[candidate.case] === 'warm' && (
                              <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-semibold text-emerald-400">
                                GPU Warm
                              </span>
                            )}
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
              {/* Axis Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Slice plane axis
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['z', 'x', 'y'] as SliceAxis[]).map((ax) => (
                    <button
                      key={ax}
                      type="button"
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        sliceAxis === ax
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'border border-input bg-background hover:bg-accent'
                      }`}
                      onClick={() => {
                        clearPrediction()
                        setSliceAxis(ax)
                        if (ax === 'z') setSliceValue(1.1)
                        else if (ax === 'x') setSliceValue(4.4)
                        else if (ax === 'y') setSliceValue(3.05)
                      }}
                    >
                      {ax.toUpperCase()}{' '}
                      {ax === 'z' ? '(Floor)' : ax === 'x' ? '(Cross)' : '(Long)'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quick Preset Buttons for Z */}
              {sliceAxis === 'z' && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">Presets:</span>
                  <button
                    type="button"
                    className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] hover:bg-muted"
                    onClick={() => {
                      setSliceValue(1.1)
                      setMetric('comfort')
                      if (selectedCase && selectedModel) {
                        fetchSliceForCase(selectedCase, selectedModel, 1.1, spacing, 'z')
                      }
                    }}
                  >
                    Seated (1.1m)
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] hover:bg-muted"
                    onClick={() => {
                      setSliceValue(1.7)
                      setMetric('comfort')
                      if (selectedCase && selectedModel) {
                        fetchSliceForCase(selectedCase, selectedModel, 1.7, spacing, 'z')
                      }
                    }}
                  >
                    Standing (1.7m)
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1.5 text-xs font-medium">
                  {sliceAxis === 'z'
                    ? 'Height Z (m)'
                    : sliceAxis === 'x'
                      ? 'Position X (m)'
                      : 'Position Y (m)'}
                  <input
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                    max={sliceAxis === 'x' ? 8.7 : sliceAxis === 'y' ? 6.0 : 3.1}
                    min={0.1}
                    onChange={(event) => {
                      clearPrediction()
                      setSliceValue(Number(event.target.value))
                    }}
                    required
                    step="0.05"
                    type="number"
                    value={sliceValue}
                  />
                </label>
                <label className="space-y-1.5 text-xs font-medium">
                  Grid spacing (m)
                  <div className="flex gap-1.5 pt-0.5">
                    {[0.1, 0.2, 0.25].map((sp) => (
                      <button
                        key={sp}
                        type="button"
                        className={`flex-1 rounded border py-1.5 text-xs ${
                          spacing === sp
                            ? 'border-primary bg-primary/10 font-medium text-primary'
                            : 'border-input bg-background text-muted-foreground'
                        }`}
                        onClick={() => {
                          clearPrediction()
                          setSpacing(sp)
                        }}
                      >
                        {sp}m
                      </button>
                    ))}
                  </div>
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
                    onChange={(event) => setMetric(event.target.value as ComfortMetric)}
                    value={metric}
                  >
                    <option value="speed">Speed (m/s)</option>
                    <option value="temperature">Temperature (K)</option>
                    <option value="comfort">ASHRAE 55 Comfort</option>
                  </select>
                </div>
                {result ? (
                  <>
                    <FieldMap details={details} metric={metric} result={result} />
                    <p className="text-[11px] text-muted-foreground">
                      {result.case} · {result.run} · {sliceAxis.toUpperCase()} ={' '}
                      {result.value.toFixed(2)} m
                    </p>

                    {/* ASHRAE 55 Comfort Breakdown */}
                    {comfortStats && (
                      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
                        <div className="flex items-center justify-between font-medium">
                          <span>ASHRAE 55 Comfort Distribution</span>
                          <span className="font-semibold text-emerald-500">
                            {comfortStats.comfortPct}% Comfort Zone
                          </span>
                        </div>
                        {/* 3-color stacked bar */}
                        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                          <div
                            style={{ width: `${comfortStats.comfortPct}%` }}
                            className="bg-emerald-500 transition-all duration-300"
                            title={`Comfort: ${comfortStats.comfortPct}%`}
                          />
                          <div
                            style={{ width: `${comfortStats.draftPct}%` }}
                            className="bg-blue-500 transition-all duration-300"
                            title={`Draft Risk: ${comfortStats.draftPct}%`}
                          />
                          <div
                            style={{ width: `${comfortStats.stagnantPct}%` }}
                            className="bg-amber-500 transition-all duration-300"
                            title={`Stagnant: ${comfortStats.stagnantPct}%`}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] text-muted-foreground pt-0.5">
                          <span className="flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" />
                            Comfort: {comfortStats.comfortPct}%
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-blue-500" />
                            Draft Risk: {comfortStats.draftPct}%
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-amber-500" />
                            Stagnant: {comfortStats.stagnantPct}%
                          </span>
                        </div>
                      </div>
                    )}
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
