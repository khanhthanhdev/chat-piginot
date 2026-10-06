import { jsPDF } from 'jspdf'
import type { CandidateResult, HvacReportData } from './airflow-store'

export interface ExportReportOptions {
  reportData: HvacReportData
  canvasElement?: HTMLCanvasElement | null
  candidates?: CandidateResult[]
  saveToFile?: boolean
}

type Rgb = [number, number, number]

export function exportReportToPdf(options: ExportReportOptions): jsPDF {
  const { reportData, canvasElement, candidates, saveToFile = true } = options
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  })

  const pageWidth = 210
  const pageHeight = 297
  const margin = 14
  const contentWidth = pageWidth - margin * 2

  let y = margin

  // --- PAGE 1: TITLE BLOCK & METADATA ---
  // Top Header Banner
  doc.setFillColor(15, 23, 42) // Slate 900
  doc.rect(margin, y, contentWidth, 22, 'F')

  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('PASCAL INDOOR CLIMATE LAB', margin + 4, y + 7)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(148, 163, 184)
  doc.text('HVAC OPTIMIZATION & ASHRAE 55-2023 COMPLIANCE REPORT', margin + 4, y + 13)
  doc.text('LGO NEURAL OPERATOR SURROGATE SIMULATION', margin + 4, y + 18)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(241, 245, 249)
  doc.text(`CASE: ${reportData.case}`, pageWidth - margin - 4, y + 8, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(203, 213, 225)
  doc.text(`ID: ${reportData.report_id}`, pageWidth - margin - 4, y + 14, { align: 'right' })
  doc.text(`DATE: ${reportData.generated_at}`, pageWidth - margin - 4, y + 19, { align: 'right' })

  y += 26

  // Executive Summary Card
  const score = reportData.composite_score
  const isPass = reportData.overall_verdict === 'COMPLIANT'
  const isMarginal = reportData.overall_verdict === 'CONDITIONALLY COMPLIANT'

  // Card Background
  doc.setFillColor(248, 250, 252) // Slate 50
  doc.setDrawColor(226, 232, 240)
  doc.roundedRect(margin, y, contentWidth, 34, 1.5, 1.5, 'FD')

  // Score Badge box
  const badgeColor: Rgb = isPass ? [22, 101, 52] : isMarginal ? [180, 83, 9] : [153, 27, 27]
  const badgeBg: Rgb = isPass ? [240, 253, 244] : isMarginal ? [254, 252, 232] : [254, 242, 242]

  doc.setFillColor(badgeBg[0], badgeBg[1], badgeBg[2])
  doc.setDrawColor(badgeColor[0], badgeColor[1], badgeColor[2])
  doc.roundedRect(margin + 4, y + 4, 38, 26, 1, 1, 'FD')

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(badgeColor[0], badgeColor[1], badgeColor[2])
  doc.text('COMPOSITE SCORE', margin + 23, y + 10, { align: 'center' })

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(`${score.toFixed(1)}`, margin + 23, y + 19, { align: 'center' })

  doc.setFontSize(6.5)
  doc.text('/ 100 PTS', margin + 23, y + 25, { align: 'center' })

  // Executive Narrative
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(15, 23, 42)
  doc.text(`OVERALL ASSESSMENT: ${reportData.overall_verdict}`, margin + 46, y + 9)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(71, 85, 105)
  doc.text(
    `Objective: ${reportData.optimization_priority.replace(/_/g, ' ').toUpperCase()} | Standard: ${reportData.standard}`,
    margin + 46,
    y + 14,
  )

  const summaryLines = doc.splitTextToSize(reportData.summary_statement, contentWidth - 50)
  doc.setTextColor(51, 65, 85)
  doc.setFontSize(7.8)
  doc.text(summaryLines, margin + 46, y + 20)

  y += 38

  // Section 1: Facility Geometry & Evaluation Plane
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(15, 23, 42)
  doc.text('1. FACILITY GEOMETRY & EVALUATION PLANE', margin, y)

  y += 3
  doc.setFillColor(255, 255, 255)
  doc.setDrawColor(226, 232, 240)
  doc.rect(margin, y, contentWidth, 14, 'FD')

  const roomText = `Room Enclosure: ${reportData.room.length_x_m.toFixed(2)}m (L) × ${reportData.room.width_y_m.toFixed(2)}m (W) × ${reportData.room.height_z_m.toFixed(2)}m (H)`
  const areaVolText = `Floor Area: ${reportData.room.floor_area_m2.toFixed(1)} m² | Volume: ${reportData.room.volume_m3.toFixed(1)} m³`
  const planeText = `Evaluation Plane: Z = ${reportData.evaluation_plane.height_m.toFixed(2)}m (${reportData.evaluation_plane.description}) | Spacing: ${reportData.evaluation_plane.spacing_m.toFixed(2)}m`
  const terminalCountText = `Terminals: ${reportData.supply_count} Ceiling Supply Diffusers, ${reportData.return_count} Ceiling Return Grilles`

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(71, 85, 105)
  doc.text(roomText, margin + 4, y + 5)
  doc.text(areaVolText, margin + 4, y + 10)
  doc.text(planeText, margin + contentWidth / 2, y + 5)
  doc.text(terminalCountText, margin + contentWidth / 2, y + 10)

  y += 18

  // Section 2: ASHRAE 55-2023 Occupied-Zone Performance Matrix
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(15, 23, 42)
  doc.text('2. ASHRAE 55-2023 OCCUPIED-ZONE COMFORT CRITERIA', margin, y)

  y += 3

  // Table Header
  doc.setFillColor(241, 245, 249)
  doc.rect(margin, y, contentWidth, 7, 'F')
  doc.setDrawColor(203, 213, 225)
  doc.line(margin, y + 7, margin + contentWidth, y + 7)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  doc.setTextColor(51, 65, 85)
  doc.text('PARAMETER & DESCRIPTION', margin + 3, y + 4.8)
  doc.text('GOVERNING STANDARD', margin + 85, y + 4.8)
  doc.text('TARGET', margin + 125, y + 4.8)
  doc.text('MEASURED', margin + 148, y + 4.8)
  doc.text('STATUS', margin + 172, y + 4.8)

  y += 7

  let checkIdx = 0
  for (const item of reportData.compliance_checks) {
    const rowBg = checkIdx % 2 === 0 ? 255 : 250
    checkIdx++
    doc.setFillColor(rowBg, rowBg, rowBg)
    doc.rect(margin, y, contentWidth, 8, 'F')
    doc.setDrawColor(241, 245, 249)
    doc.line(margin, y + 8, margin + contentWidth, y + 8)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.2)
    doc.setTextColor(15, 23, 42)
    doc.text(item.parameter, margin + 3, y + 5.2)

    doc.setFontSize(7)
    doc.setTextColor(100, 116, 139)
    doc.text(item.standard, margin + 85, y + 5.2)

    doc.setTextColor(71, 85, 105)
    doc.text(item.target, margin + 125, y + 5.2)

    doc.setFont('helvetica', 'bold')
    doc.setTextColor(15, 23, 42)
    doc.text(item.measured, margin + 148, y + 5.2)

    // Status Pill
    const pillColor: Rgb =
      item.status === 'PASS'
        ? [22, 101, 52]
        : item.status === 'MARGINAL'
          ? [180, 83, 9]
          : [185, 28, 28]
    doc.setTextColor(pillColor[0], pillColor[1], pillColor[2])
    doc.text(item.status, margin + 172, y + 5.2)

    y += 8
  }

  y += 4

  // Velocity Field Key Statistics Row
  doc.setFillColor(248, 250, 252)
  doc.setDrawColor(226, 232, 240)
  doc.roundedRect(margin, y, contentWidth, 12, 1, 1, 'FD')

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(71, 85, 105)
  doc.text(
    `Mean Occupied Velocity: ${reportData.kpis.mean_velocity.toFixed(3)} m/s`,
    margin + 5,
    y + 7.5,
  )
  doc.text(
    `Max Peak Velocity: ${reportData.kpis.max_velocity.toFixed(3)} m/s`,
    margin + 65,
    y + 7.5,
  )
  doc.text(
    `Thermal Uniformity: ${(reportData.kpis.temp_uniformity * 100).toFixed(1)}%`,
    margin + 125,
    y + 7.5,
  )

  y += 16

  // Section 3: Diffuser & Return Terminal Schedule
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(15, 23, 42)
  doc.text('3. TERMINAL EQUIPMENT SCHEDULE (CEILING LEVEL Z = 3.20m)', margin, y)

  y += 3

  // Terminal Table Header
  doc.setFillColor(241, 245, 249)
  doc.rect(margin, y, contentWidth, 6.5, 'F')
  doc.setDrawColor(203, 213, 225)
  doc.line(margin, y + 6.5, margin + contentWidth, y + 6.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  doc.setTextColor(51, 65, 85)
  doc.text('TERMINAL ID', margin + 4, y + 4.5)
  doc.text('EQUIPMENT CLASSIFICATION', margin + 35, y + 4.5)
  doc.text('COORDINATE X (m)', margin + 90, y + 4.5)
  doc.text('COORDINATE Y (m)', margin + 125, y + 4.5)
  doc.text('ELEVATION Z (m)', margin + 155, y + 4.5)

  y += 6.5

  const terminalRows = reportData.terminal_schedule.slice(0, 10)
  let termIdx = 0
  for (const t of terminalRows) {
    const rowBg = termIdx % 2 === 0 ? 255 : 252
    termIdx++
    doc.setFillColor(rowBg, rowBg, rowBg)
    doc.rect(margin, y, contentWidth, 6, 'F')
    doc.setDrawColor(241, 245, 249)
    doc.line(margin, y + 6, margin + contentWidth, y + 6)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    doc.setTextColor(15, 23, 42)
    doc.text(t.id, margin + 4, y + 4.2)

    doc.setFont('helvetica', 'normal')
    doc.setTextColor(71, 85, 105)
    doc.text(t.type, margin + 35, y + 4.2)
    doc.text(`${t.x.toFixed(2)}`, margin + 90, y + 4.2)
    doc.text(`${t.y.toFixed(2)}`, margin + 125, y + 4.2)
    doc.text(`${t.z.toFixed(2)}`, margin + 155, y + 4.2)

    y += 6
  }

  // Footer on Page 1
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.8)
  doc.setTextColor(148, 163, 184)
  doc.text(
    'PASCAL CLIMATE SYSTEMS — CONFIDENTIAL REPORT GENERATED VIA LGO DIGITAL TWIN ENGINE',
    margin,
    pageHeight - 8,
  )
  doc.text('PAGE 1 OF 2', pageWidth - margin, pageHeight - 8, { align: 'right' })

  // --- PAGE 2: VISUALIZATION & CANDIDATE COMPARISON ---
  doc.addPage()
  y = margin

  // Page 2 Header Banner
  doc.setFillColor(15, 23, 42)
  doc.rect(margin, y, contentWidth, 12, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.text('FLOW DISTRIBUTION VISUALIZATION & ALTERNATIVE COMPARISON', margin + 4, y + 7.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(203, 213, 225)
  doc.text(`CASE: ${reportData.case}`, pageWidth - margin - 4, y + 7.5, { align: 'right' })

  y += 16

  // 4. Airflow Distribution Slice Snapshot
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(15, 23, 42)
  doc.text('4. OCCUPIED-ZONE AIRFLOW FIELD SNAPSHOT (Z = 1.10m)', margin, y)

  y += 4

  if (canvasElement) {
    try {
      const imgData = canvasElement.toDataURL('image/png')
      const imgWidth = contentWidth
      const imgHeight = (contentWidth * 6.1) / 8.8
      doc.addImage(imgData, 'PNG', margin, y, imgWidth, imgHeight)

      doc.setDrawColor(203, 213, 225)
      doc.rect(margin, y, imgWidth, imgHeight, 'S')

      y += imgHeight + 4

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7)
      doc.setTextColor(100, 116, 139)
      doc.text(
        'Colormap scalar field showing flow distribution across room boundary [0.0m - 8.8m] × [0.0m - 6.1m]. Blue diffusers indicate conditioned air supply.',
        margin,
        y,
      )
      y += 6
    } catch {
      y += 6
    }
  } else {
    doc.setFillColor(248, 250, 252)
    doc.setDrawColor(226, 232, 240)
    doc.rect(margin, y, contentWidth, 30, 'FD')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(148, 163, 184)
    doc.text('3D Viewport slice rendered in editor interface.', margin + contentWidth / 2, y + 16, {
      align: 'center',
    })
    y += 34
  }

  // 5. Optimization Comparison Matrix (if candidates present)
  if (candidates && candidates.length > 0) {
    y += 2
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(15, 23, 42)
    doc.text('5. OPTIMIZATION CANDIDATE COMPARISON MATRIX', margin, y)

    y += 3
    doc.setFillColor(241, 245, 249)
    doc.rect(margin, y, contentWidth, 6.5, 'F')
    doc.setDrawColor(203, 213, 225)
    doc.line(margin, y + 6.5, margin + contentWidth, y + 6.5)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    doc.setTextColor(51, 65, 85)
    doc.text('RANK', margin + 3, y + 4.5)
    doc.text('CASE ID', margin + 18, y + 4.5)
    doc.text('SET', margin + 42, y + 4.5)
    doc.text('SCORE', margin + 70, y + 4.5)
    doc.text('SWEEP %', margin + 95, y + 4.5)
    doc.text('DEAD ZONE %', margin + 120, y + 4.5)
    doc.text('DRAFT RISK %', margin + 148, y + 4.5)
    doc.text('VERDICT', margin + 172, y + 4.5)

    y += 6.5

    const candidateList = candidates.slice(0, 5)
    let cIdx = 0
    for (const cand of candidateList) {
      const rowBg = cIdx % 2 === 0 ? 255 : 250
      doc.setFillColor(rowBg, rowBg, rowBg)
      doc.rect(margin, y, contentWidth, 6, 'F')
      doc.setDrawColor(241, 245, 249)
      doc.line(margin, y + 6, margin + contentWidth, y + 6)

      const isTop = cIdx === 0
      cIdx++
      doc.setFont('helvetica', isTop ? 'bold' : 'normal')
      doc.setFontSize(7)
      doc.setTextColor(isTop ? 22 : 51, isTop ? 101 : 65, isTop ? 52 : 85)
      doc.text(isTop ? '#1 RECOM.' : `#${cIdx}`, margin + 3, y + 4.2)

      doc.setTextColor(15, 23, 42)
      doc.text(cand.case, margin + 18, y + 4.2)

      doc.setTextColor(100, 116, 139)
      doc.text(cand.set, margin + 42, y + 4.2)

      doc.setFont('helvetica', 'bold')
      doc.setTextColor(15, 23, 42)
      doc.text(cand.score.toFixed(1), margin + 70, y + 4.2)

      doc.setFont('helvetica', 'normal')
      doc.setTextColor(71, 85, 105)
      doc.text(`${(cand.kpis.air_sweep_coverage * 100).toFixed(1)}%`, margin + 95, y + 4.2)
      doc.text(`${(cand.kpis.dead_zone_ratio * 100).toFixed(1)}%`, margin + 120, y + 4.2)
      doc.text(`${(cand.kpis.draft_risk_ratio * 100).toFixed(1)}%`, margin + 148, y + 4.2)

      const verdict = cand.score >= 75 ? 'PASS' : cand.score >= 60 ? 'COND.' : 'FAIL'
      const vColor: Rgb =
        verdict === 'PASS' ? [22, 101, 52] : verdict === 'COND.' ? [180, 83, 9] : [185, 28, 28]
      doc.setTextColor(vColor[0], vColor[1], vColor[2])
      doc.text(verdict, margin + 172, y + 4.2)

      y += 6
    }
  }

  // Methodology & Sign-off Box
  y = Math.max(y + 4, pageHeight - 38)
  doc.setFillColor(248, 250, 252)
  doc.setDrawColor(226, 232, 240)
  doc.roundedRect(margin, y, contentWidth, 24, 1, 1, 'FD')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(15, 23, 42)
  doc.text('METHODOLOGY & SURROGATE ACCURACY NOTE', margin + 4, y + 5.5)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.8)
  doc.setTextColor(71, 85, 105)
  doc.text(
    'This assessment is derived from 3D steady-state Learned Graph Operator (LGO) neural surrogate solutions benchmarked against incompressible Navier-Stokes CFD simulations. Fluid variables (u, v, w velocity vectors and thermal scalar fields) were computed at normalized indoor air standard conditions.',
    margin + 4,
    y + 10,
    { maxWidth: contentWidth - 8 },
  )
  doc.text(
    `Certified for HVAC design verification — Model Run: ${reportData.run} | Standard: ${reportData.standard}`,
    margin + 4,
    y + 20,
  )

  // Footer on Page 2
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.8)
  doc.setTextColor(148, 163, 184)
  doc.text(
    'PASCAL CLIMATE SYSTEMS — CONFIDENTIAL REPORT GENERATED VIA LGO DIGITAL TWIN ENGINE',
    margin,
    pageHeight - 8,
  )
  doc.text('PAGE 2 OF 2', pageWidth - margin, pageHeight - 8, { align: 'right' })

  // Trigger Save if requested
  if (saveToFile) {
    doc.save(`HVAC-Optimization-Report-${reportData.case}.pdf`)
  }
  return doc
}
