import { create } from 'zustand'

export type Point2 = [number, number]

export type CaseDetails = {
  case?: string
  room: { min: [number, number, number]; max: [number, number, number] }
  supply_vents_xy: Point2[]
  return_vents_xy: Point2[]
}

export type SliceResult = {
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

export type CandidateResult = {
  case: string
  set: string
  score: number
  kpis: {
    composite_score: number
    mean_velocity: number
    max_velocity: number
    dead_zone_ratio: number
    air_sweep_coverage: number
    draft_risk_ratio: number
    temp_uniformity: number
  }
  supply_vents_xy: Point2[]
  return_vents_xy: Point2[]
}
export type ComplianceCheck = {
  parameter: string
  standard: string
  target: string
  measured: string
  status: 'PASS' | 'MARGINAL' | 'FAIL'
}

export type TerminalItem = {
  id: string
  type: string
  x: number
  y: number
  z: number
  function: string
}

export type HvacReportData = {
  report_id: string
  generated_at: string
  case: string
  dataset_set?: string
  run: string
  standard: string
  evaluation_plane: {
    axis: string
    height_m: number
    spacing_m: number
    description: string
  }
  room: {
    length_x_m: number
    width_y_m: number
    height_z_m: number
    floor_area_m2: number
    volume_m3: number
  }
  optimization_priority: string
  composite_score: number
  overall_verdict: 'COMPLIANT' | 'CONDITIONALLY COMPLIANT' | 'NON-COMPLIANT'
  summary_statement: string
  kpis: {
    composite_score: number
    mean_velocity: number
    max_velocity: number
    dead_zone_ratio: number
    air_sweep_coverage: number
    draft_risk_ratio: number
    temp_uniformity: number
  }
  compliance_checks: ComplianceCheck[]
  terminal_schedule: TerminalItem[]
  supply_count: number
  return_count: number
}

export type AirflowStore = {
  selectedCase: string
  selectedModel: string
  details: CaseDetails | null
  sliceResult: SliceResult | null
  sliceHeight: number
  spacing: number
  metric: 'speed' | 'temperature'
  show3DSlice: boolean
  sliceOpacity: number
  optimizerPriority: 'balanced' | 'minimize_draft' | 'eliminate_dead_zones'
  isOptimizing: boolean
  rankedCandidates: CandidateResult[]
  isReportModalOpen: boolean
  reportData: HvacReportData | null
  isLoadingReport: boolean

  setSelectedCase: (caseId: string) => void
  setSelectedModel: (modelId: string) => void
  setDetails: (details: CaseDetails | null) => void
  setSliceResult: (result: SliceResult | null) => void
  setSliceHeight: (height: number) => void
  setSpacing: (spacing: number) => void
  setMetric: (metric: 'speed' | 'temperature') => void
  setShow3DSlice: (show: boolean) => void
  setSliceOpacity: (opacity: number) => void
  setOptimizerPriority: (priority: 'balanced' | 'minimize_draft' | 'eliminate_dead_zones') => void
  setIsOptimizing: (optimizing: boolean) => void
  setRankedCandidates: (candidates: CandidateResult[]) => void
  setIsReportModalOpen: (open: boolean) => void
  setReportData: (data: HvacReportData | null) => void
  setIsLoadingReport: (loading: boolean) => void
}

export const useAirflowStore = create<AirflowStore>((set) => ({
  selectedCase: '',
  selectedModel: '',
  details: null,
  sliceResult: null,
  sliceHeight: 1.1,
  spacing: 0.2,
  metric: 'speed',
  show3DSlice: true,
  sliceOpacity: 0.8,
  optimizerPriority: 'balanced',
  isOptimizing: false,
  rankedCandidates: [],
  isReportModalOpen: false,
  reportData: null,
  isLoadingReport: false,

  setSelectedCase: (caseId) => set({ selectedCase: caseId }),
  setSelectedModel: (modelId) => set({ selectedModel: modelId }),
  setDetails: (details) => set({ details }),
  setSliceResult: (sliceResult) => set({ sliceResult }),
  setSliceHeight: (sliceHeight) => set({ sliceHeight }),
  setSpacing: (spacing) => set({ spacing }),
  setMetric: (metric) => set({ metric }),
  setShow3DSlice: (show3DSlice) => set({ show3DSlice }),
  setSliceOpacity: (sliceOpacity) => set({ sliceOpacity }),
  setOptimizerPriority: (optimizerPriority) => set({ optimizerPriority }),
  setIsOptimizing: (isOptimizing) => set({ isOptimizing }),
  setRankedCandidates: (rankedCandidates) => set({ rankedCandidates }),
  setIsReportModalOpen: (isReportModalOpen) => set({ isReportModalOpen }),
  setReportData: (reportData) => set({ reportData }),
  setIsLoadingReport: (isLoadingReport) => set({ isLoadingReport }),
}))
