import { describe, expect, it } from 'bun:test'
import { useAirflowStore } from './airflow-store'

describe('useAirflowStore', () => {
  it('has valid defaults and updates state via actions', () => {
    const state = useAirflowStore.getState()
    expect(state.selectedCase).toBe('')
    expect(state.sliceHeight).toBe(1.1)
    expect(state.show3DSlice).toBe(true)
    expect(state.sliceOpacity).toBe(0.8)
    expect(state.optimizerPriority).toBe('balanced')
    expect(state.isOptimizing).toBe(false)
    expect(state.rankedCandidates).toEqual([])

    useAirflowStore.getState().setSelectedCase('D006')
    expect(useAirflowStore.getState().selectedCase).toBe('D006')

    useAirflowStore.getState().setSliceHeight(1.5)
    expect(useAirflowStore.getState().sliceHeight).toBe(1.5)

    useAirflowStore.getState().setShow3DSlice(false)
    expect(useAirflowStore.getState().show3DSlice).toBe(false)

    useAirflowStore.getState().setSliceOpacity(0.5)
    expect(useAirflowStore.getState().sliceOpacity).toBe(0.5)

    useAirflowStore.getState().setOptimizerPriority('minimize_draft')
    expect(useAirflowStore.getState().optimizerPriority).toBe('minimize_draft')

    useAirflowStore.getState().setIsOptimizing(true)
    expect(useAirflowStore.getState().isOptimizing).toBe(true)

    useAirflowStore.getState().setRankedCandidates([
      {
        case: 'D006',
        set: 'val',
        score: 75.2,
        kpis: {
          composite_score: 75.2,
          mean_velocity: 0.18,
          max_velocity: 0.45,
          dead_zone_ratio: 0.12,
          air_sweep_coverage: 0.78,
          draft_risk_ratio: 0.05,
          temp_uniformity: 0.92,
        },
        supply_vents_xy: [[1.0, 2.0]],
        return_vents_xy: [[3.0, 4.0]],
      },
    ])
    expect(useAirflowStore.getState().rankedCandidates.length).toBe(1)
    expect(useAirflowStore.getState().rankedCandidates[0]?.score).toBe(75.2)

    expect(state.isReportModalOpen).toBe(false)
    expect(state.reportData).toBeNull()
    expect(state.isLoadingReport).toBe(false)

    useAirflowStore.getState().setIsReportModalOpen(true)
    expect(useAirflowStore.getState().isReportModalOpen).toBe(true)

    useAirflowStore.getState().setIsLoadingReport(true)
    expect(useAirflowStore.getState().isLoadingReport).toBe(true)

    useAirflowStore.getState().setReportData({
      report_id: 'REP-HVAC-D006-12345',
      generated_at: '2026-10-06 12:00:00 UTC',
      case: 'D006',
      run: 'final30_lgo_ginot_lr1e-3',
      standard: 'ASHRAE Standard 55-2023',
      evaluation_plane: {
        axis: 'z',
        height_m: 1.1,
        spacing_m: 0.25,
        description: 'Seated Occupant Breathing Zone',
      },
      room: {
        length_x_m: 8.8,
        width_y_m: 6.1,
        height_z_m: 3.2,
        floor_area_m2: 53.68,
        volume_m3: 171.78,
      },
      optimization_priority: 'balanced',
      composite_score: 75.2,
      overall_verdict: 'COMPLIANT',
      summary_statement: 'Satisfies ASHRAE 55-2023 benchmarks.',
      kpis: {
        composite_score: 75.2,
        mean_velocity: 0.18,
        max_velocity: 0.45,
        dead_zone_ratio: 0.12,
        air_sweep_coverage: 0.78,
        draft_risk_ratio: 0.05,
        temp_uniformity: 0.92,
      },
      compliance_checks: [
        {
          parameter: 'Occupied Air-Sweep Effective Circulation (0.10 - 0.30 m/s)',
          standard: 'ASHRAE 55-2023 §5.3.3',
          target: '≥ 60.0%',
          measured: '78.0%',
          status: 'PASS',
        },
      ],
      terminal_schedule: [
        {
          id: 'SUP-01',
          type: 'Supply Diffuser',
          x: 2.2,
          y: 3.1,
          z: 3.2,
          function: 'Conditioned Air Supply',
        },
      ],
      supply_count: 1,
      return_count: 1,
    })
    expect(useAirflowStore.getState().reportData?.report_id).toBe('REP-HVAC-D006-12345')
    expect(useAirflowStore.getState().reportData?.overall_verdict).toBe('COMPLIANT')

    // Reset back
    useAirflowStore.getState().setShow3DSlice(true)
    useAirflowStore.getState().setIsOptimizing(false)
    useAirflowStore.getState().setIsReportModalOpen(false)
    useAirflowStore.getState().setReportData(null)
    useAirflowStore.getState().setIsLoadingReport(false)
  })
})
