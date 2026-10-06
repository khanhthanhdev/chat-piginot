import { describe, expect, it } from 'bun:test'
import type { CandidateResult, HvacReportData } from './airflow-store'
import { exportReportToPdf } from './hvac-report-pdf'

describe('HVAC Report PDF Export', () => {
  it('generates multi-page PDF document with compliance matrix and candidate comparisons', () => {
    const mockReportData: HvacReportData = {
      report_id: 'REP-HVAC-D006-99999',
      generated_at: '2026-10-06 14:00:00 UTC',
      case: 'D006',
      dataset_set: 'gap30',
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
      summary_statement: 'Satisfies ASHRAE 55-2023 thermal comfort criteria.',
      kpis: {
        composite_score: 75.2,
        mean_velocity: 0.182,
        max_velocity: 0.412,
        dead_zone_ratio: 0.128,
        air_sweep_coverage: 0.684,
        draft_risk_ratio: 0.082,
        temp_uniformity: 0.941,
      },
      compliance_checks: [
        {
          parameter: 'Occupied Air-Sweep Effective Circulation (0.10 - 0.30 m/s)',
          standard: 'ASHRAE 55-2023 §5.3.3',
          target: '≥ 60.0%',
          measured: '68.4%',
          status: 'PASS',
        },
        {
          parameter: 'Stagnant Air Dead-Zone Ratio (< 0.10 m/s)',
          standard: 'ASHRAE 55-2023 §5.3.4',
          target: '≤ 20.0%',
          measured: '12.8%',
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
        {
          id: 'RET-01',
          type: 'Return Grille',
          x: 6.5,
          y: 1.5,
          z: 3.2,
          function: 'Return Air Extraction',
        },
      ],
      supply_count: 1,
      return_count: 1,
    }

    const mockCandidates: CandidateResult[] = [
      {
        case: 'D006',
        set: 'gap30',
        score: 75.2,
        kpis: mockReportData.kpis,
        supply_vents_xy: [[2.2, 3.1]],
        return_vents_xy: [[6.5, 1.5]],
      },
      {
        case: 'B001',
        set: 'gap30',
        score: 64.8,
        kpis: {
          ...mockReportData.kpis,
          composite_score: 64.8,
          air_sweep_coverage: 0.52,
          dead_zone_ratio: 0.28,
        },
        supply_vents_xy: [[1.5, 2.5]],
        return_vents_xy: [[5.0, 4.0]],
      },
    ]

    const doc = exportReportToPdf({
      reportData: mockReportData,
      canvasElement: null,
      candidates: mockCandidates,
      saveToFile: false,
    })

    expect(doc).toBeDefined()
    expect(doc.getNumberOfPages()).toBe(2)
    expect(Math.round(doc.internal.pageSize.getWidth())).toBe(210)
    expect(Math.round(doc.internal.pageSize.getHeight())).toBe(297)
  })
})
