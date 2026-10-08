import { describe, expect, it } from 'bun:test'
import { type SliceResult, useAirflowStore } from './airflow-store'

describe('useAirflowStore', () => {
  it('has valid defaults and updates state via actions', () => {
    const state = useAirflowStore.getState()
    expect(state.selectedCase).toBe('')
    expect(state.sliceAxis).toBe('z')
    expect(state.sliceValue).toBe(1.1)
    expect(state.sliceHeight).toBe(1.1)
    expect(state.metric).toBe('speed')
    expect(state.show3DSlice).toBe(true)
    expect(state.sliceOpacity).toBe(0.8)
    expect(state.showParticles).toBe(false)
    expect(state.particleSpeed).toBe(1.0)
    expect(state.isProbingActive).toBe(false)
    expect(state.probePoint).toBeNull()
    expect(state.virtualSensors).toEqual([])
    expect(state.isCompareActive).toBe(false)
    expect(state.compareCase).toBe('')
    expect(state.compareSliceResult).toBeNull()
    expect(state.compareMetrics).toBeNull()
    expect(state.isLoadingCompare).toBe(false)
    expect(state.caseWarmStatus).toEqual({})
    expect(state.setupTime).toBeNull()
    expect(state.optimizerPriority).toBe('balanced')
    expect(state.isOptimizing).toBe(false)
    expect(state.rankedCandidates).toEqual([])
    useAirflowStore.getState().setSelectedCase('D006')
    expect(useAirflowStore.getState().selectedCase).toBe('D006')

    useAirflowStore.getState().setSliceAxis('x')
    expect(useAirflowStore.getState().sliceAxis).toBe('x')

    useAirflowStore.getState().setSliceValue(2.5)
    expect(useAirflowStore.getState().sliceValue).toBe(2.5)
    expect(useAirflowStore.getState().sliceHeight).toBe(2.5)

    useAirflowStore.getState().setSliceHeight(1.5)
    expect(useAirflowStore.getState().sliceHeight).toBe(1.5)
    expect(useAirflowStore.getState().sliceValue).toBe(1.5)

    useAirflowStore.getState().setMetric('comfort')
    expect(useAirflowStore.getState().metric).toBe('comfort')

    useAirflowStore.getState().setShowParticles(true)
    expect(useAirflowStore.getState().showParticles).toBe(true)

    useAirflowStore.getState().setParticleSpeed(2.0)
    expect(useAirflowStore.getState().particleSpeed).toBe(2.0)

    useAirflowStore.getState().setIsProbingActive(true)
    expect(useAirflowStore.getState().isProbingActive).toBe(true)

    useAirflowStore.getState().setProbePoint({
      position: [2.0, 1.1, 3.0],
      u: 0.1,
      v: 0.05,
      w: -0.02,
      velocity: 0.113,
      T: 297.15,
      tempC: 24.0,
      comfortCategory: 'comfort',
    })
    expect(useAirflowStore.getState().probePoint?.comfortCategory).toBe('comfort')
    expect(useAirflowStore.getState().probePoint?.tempC).toBe(24.0)

    useAirflowStore.getState().addVirtualSensor({
      id: 'vs-1',
      name: 'Desk Sensor 1',
      position: [2.0, 1.1, 3.0],
      velocity: 0.12,
      tempC: 24.1,
      comfortCategory: 'comfort',
    })
    expect(useAirflowStore.getState().virtualSensors.length).toBe(1)
    expect(useAirflowStore.getState().virtualSensors[0]?.id).toBe('vs-1')

    useAirflowStore.getState().removeVirtualSensor('vs-1')
    expect(useAirflowStore.getState().virtualSensors.length).toBe(0)

    useAirflowStore.getState().setIsCompareActive(true)
    expect(useAirflowStore.getState().isCompareActive).toBe(true)

    useAirflowStore.getState().setCompareCase('B017')
    expect(useAirflowStore.getState().compareCase).toBe('B017')

    useAirflowStore.getState().setCompareMetrics({
      velocity_R2: 0.94,
      velocity_MAE: 0.035,
      T_MAE_K: 0.42,
    })
    expect(useAirflowStore.getState().compareMetrics?.velocity_R2).toBe(0.94)

    const sampleSlice: SliceResult = {
      run: 'test-run',
      case: 'D006',
      axis: 'z',
      value: 1.1,
      shape: [2, 2],
      axes: { x: [0, 1], y: [0, 1] },
      u: [
        [0.1, 0.2],
        [0.1, 0.2],
      ],
      v: [
        [0.0, 0.0],
        [0.0, 0.0],
      ],
      w: [
        [0.0, 0.0],
        [0.0, 0.0],
      ],
      T: [
        [295, 295],
        [295, 295],
      ],
    }
    useAirflowStore.getState().setSliceResult(sampleSlice)
    expect(useAirflowStore.getState().sliceResult).toEqual(sampleSlice)

    useAirflowStore.getState().setCompareSliceResult(sampleSlice)
    expect(useAirflowStore.getState().compareSliceResult).toEqual(sampleSlice)

    useAirflowStore.getState().setIsLoadingCompare(true)
    expect(useAirflowStore.getState().isLoadingCompare).toBe(true)
    useAirflowStore.getState().setCaseWarmStatus('D006', 'warm')
    expect(useAirflowStore.getState().caseWarmStatus['D006']).toBe('warm')

    useAirflowStore.getState().setSetupTime(12.4)
    expect(useAirflowStore.getState().setupTime).toBe(12.4)
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
