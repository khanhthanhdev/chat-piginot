'use client'

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Printer,
  X,
} from 'lucide-react'
import { useCallback, useRef } from 'react'
import { useAirflowStore } from '@/lib/airflow-store'
import { exportReportToPdf } from '@/lib/hvac-report-pdf'

export function HvacReportModal() {
  const {
    isReportModalOpen,
    setIsReportModalOpen,
    reportData,
    rankedCandidates,
    sliceResult,
    metric,
  } = useAirflowStore()

  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const handleDownloadPdf = useCallback(() => {
    if (!reportData) return
    const canvas = document.getElementById('airflow-slice-canvas') as HTMLCanvasElement | null
    exportReportToPdf({
      reportData,
      canvasElement: canvas,
      candidates: rankedCandidates,
    })
  }, [reportData, rankedCandidates])

  const handlePrint = useCallback(() => {
    window.print()
  }, [])

  const handleDownloadHtml = useCallback(() => {
    if (!reportData) return
    const printable = document.getElementById('hvac-report-printable')
    if (!printable) return

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HVAC Optimization Report - Case ${reportData.case}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; }
    .report-wrap { max-width: 900px; margin: 0 auto; background: #ffffff; padding: 32px; border: 1px solid #e2e8f0; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th { background: #f1f5f9; padding: 8px 12px; text-align: left; font-weight: 600; border-bottom: 1px solid #cbd5e1; }
    td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; }
    .badge { display: inline-block; padding: 2px 8px; font-size: 11px; font-weight: 700; border-radius: 4px; }
    .pass { background: #dcfce7; color: #166534; }
    .marginal { background: #fef9c3; color: #854d0e; }
    .fail { background: #fee2e2; color: #991b1b; }
    @media print { body { background: white; padding: 0; } .report-wrap { border: none; box-shadow: none; padding: 0; } }
  </style>
</head>
<body>
  <div class="report-wrap">
    ${printable.innerHTML}
  </div>
</body>
</html>`

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `HVAC-Optimization-Report-${reportData.case}.html`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [reportData])

  if (!isReportModalOpen || !reportData) {
    return null
  }

  const isCompliant = reportData.overall_verdict === 'COMPLIANT'
  const isMarginal = reportData.overall_verdict === 'CONDITIONALLY COMPLIANT'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-6 overflow-y-auto">
      {/* Print Stylesheet */}
      <style>{`
        @media print {
          body * {
            visibility: hidden !important;
          }
          #hvac-report-printable, #hvac-report-printable * {
            visibility: visible !important;
          }
          #hvac-report-printable {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 10mm 15mm !important;
            background: white !important;
            color: #0f172a !important;
            z-index: 999999 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .no-print {
            display: none !important;
          }
          @page {
            size: A4 portrait;
            margin: 10mm;
          }
        }
      `}</style>

      <div className="relative w-full max-w-4xl bg-white text-slate-900 rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Modal Top Bar (Non-printable) */}
        <div className="no-print flex items-center justify-between px-6 py-4 bg-slate-900 text-white border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-sky-500/20 text-sky-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold leading-tight">
                HVAC Optimization & Compliance Report
              </h2>
              <p className="text-xs text-slate-400">
                Case {reportData.case} — ASHRAE Standard 55-2023 Thermal Comfort Analysis
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-sky-600 hover:bg-sky-500 text-white shadow-xs transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download PDF
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              Print / Save
            </button>

            <button
              type="button"
              onClick={handleDownloadHtml}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer"
            >
              Export HTML
            </button>

            <button
              type="button"
              onClick={() => setIsReportModalOpen(false)}
              className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer ml-2"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Report Content Area */}
        <div className="overflow-y-auto p-6 sm:p-8 bg-slate-100 flex justify-center">
          {/* Printable Report Canvas Document */}
          <div
            id="hvac-report-printable"
            className="w-full max-w-[210mm] bg-white p-8 sm:p-10 rounded-lg shadow-sm border border-slate-200 text-slate-900"
          >
            {/* Header Letterhead Banner */}
            <div className="border-b-2 border-slate-900 pb-5 mb-6">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-[10px] font-bold tracking-widest uppercase text-sky-600">
                    Pascal Indoor Climate Laboratory
                  </span>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 mt-0.5">
                    HVAC Optimization & ASHRAE 55 Compliance Report
                  </h1>
                  <p className="text-xs text-slate-500 mt-1">
                    Neural Operator (LGO) Surrogate Simulation — 3D Navier-Stokes Aerodynamic
                    Evaluation
                  </p>
                </div>
                <div className="text-right text-xs space-y-0.5">
                  <div className="font-mono font-semibold text-slate-800">
                    {reportData.report_id}
                  </div>
                  <div className="text-slate-500">{reportData.generated_at}</div>
                  <div className="inline-block px-2 py-0.5 mt-1 rounded bg-slate-100 text-[11px] font-medium text-slate-700 border border-slate-200">
                    Standard: {reportData.standard}
                  </div>
                </div>
              </div>
            </div>

            {/* Executive Verdict Summary Box */}
            <div className="mb-6 p-5 rounded-lg border bg-slate-50 border-slate-200">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div
                    className={`flex flex-col items-center justify-center w-24 h-24 rounded-lg border text-center ${
                      isCompliant
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                        : isMarginal
                          ? 'bg-amber-50 border-amber-300 text-amber-800'
                          : 'fail bg-red-50 border-red-300 text-red-800'
                    }`}
                  >
                    <span className="text-[10px] font-bold uppercase tracking-wider">Score</span>
                    <span className="text-2xl font-extrabold leading-none mt-0.5">
                      {reportData.composite_score.toFixed(1)}
                    </span>
                    <span className="text-[10px] text-slate-500 font-medium mt-0.5">/ 100 pts</span>
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold tracking-wide ${
                          isCompliant
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            : isMarginal
                              ? 'bg-amber-100 text-amber-800 border border-amber-200'
                              : 'bg-red-100 text-red-800 border border-red-200'
                        }`}
                      >
                        {isCompliant ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : isMarginal ? (
                          <AlertTriangle className="w-3.5 h-3.5" />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5" />
                        )}
                        {reportData.overall_verdict}
                      </span>
                      <span className="text-xs text-slate-500">
                        Priority: {reportData.optimization_priority.replace(/_/g, ' ')}
                      </span>
                    </div>

                    <p className="text-xs text-slate-700 mt-2 max-w-xl leading-relaxed">
                      {reportData.summary_statement}
                    </p>
                  </div>
                </div>

                <div className="text-left sm:text-right border-t sm:border-t-0 pt-3 sm:pt-0 border-slate-200 w-full sm:w-auto">
                  <div className="text-[11px] text-slate-500">Evaluated Case</div>
                  <div className="text-lg font-bold text-slate-900">{reportData.case}</div>
                  <div className="text-[11px] text-slate-500">
                    Model: <span className="font-mono text-slate-700">{reportData.run}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 1: Facility Geometry & Evaluation Plane */}
            <div className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 mb-2 border-b border-slate-200 pb-1">
                1. Facility Geometry & Evaluation Plane
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50/70 p-3 rounded border border-slate-200">
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">
                    Enclosure Dimensions
                  </span>
                  <span className="font-medium text-slate-800">
                    {reportData.room.length_x_m.toFixed(2)}m ×{' '}
                    {reportData.room.width_y_m.toFixed(2)}m ×{' '}
                    {reportData.room.height_z_m.toFixed(2)}m
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">
                    Floor Area & Volume
                  </span>
                  <span className="font-medium text-slate-800">
                    {reportData.room.floor_area_m2.toFixed(1)} m² (
                    {reportData.room.volume_m3.toFixed(1)} m³)
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">
                    Evaluation Height
                  </span>
                  <span className="font-medium text-slate-800">
                    Z = {reportData.evaluation_plane.height_m.toFixed(2)}m (Breathing Zone)
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Terminal Count</span>
                  <span className="font-medium text-slate-800">
                    {reportData.supply_count} Supply / {reportData.return_count} Return
                  </span>
                </div>
              </div>
            </div>

            {/* Section 2: ASHRAE 55-2023 Comfort Criteria Matrix */}
            <div className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 mb-2 border-b border-slate-200 pb-1">
                2. ASHRAE 55-2023 Occupied-Zone Comfort Criteria
              </h3>
              <div className="overflow-x-auto border border-slate-200 rounded">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                      <th className="py-2 px-3">Parameter & Criteria</th>
                      <th className="py-2 px-3">Governing Standard</th>
                      <th className="py-2 px-3">Target</th>
                      <th className="py-2 px-3">Measured</th>
                      <th className="py-2 px-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reportData.compliance_checks.map((c) => (
                      <tr key={c.parameter} className="hover:bg-slate-50/50">
                        <td className="py-2.5 px-3 font-medium text-slate-800">{c.parameter}</td>
                        <td className="py-2.5 px-3 text-slate-500 font-mono text-[11px]">
                          {c.standard}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">{c.target}</td>
                        <td className="py-2.5 px-3 font-bold text-slate-900">{c.measured}</td>
                        <td className="py-2.5 px-3 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                              c.status === 'PASS'
                                ? 'bg-emerald-100 text-emerald-800'
                                : c.status === 'MARGINAL'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {c.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Velocity Stats Bar */}
              <div className="grid grid-cols-3 gap-2 mt-2 text-xs bg-slate-50 p-2.5 rounded border border-slate-200">
                <div className="text-slate-600">
                  Mean Velocity:{' '}
                  <span className="font-semibold text-slate-900">
                    {reportData.kpis.mean_velocity.toFixed(3)} m/s
                  </span>
                </div>
                <div className="text-slate-600">
                  Peak Velocity:{' '}
                  <span className="font-semibold text-slate-900">
                    {reportData.kpis.max_velocity.toFixed(3)} m/s
                  </span>
                </div>
                <div className="text-slate-600">
                  Thermal Uniformity:{' '}
                  <span className="font-semibold text-slate-900">
                    {(reportData.kpis.temp_uniformity * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>

            {/* Section 3: Diffuser & Return Terminal Schedule */}
            <div className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 mb-2 border-b border-slate-200 pb-1">
                3. Terminal Equipment Schedule (Ceiling Level Z = 3.20m)
              </h3>
              <div className="overflow-x-auto border border-slate-200 rounded">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                      <th className="py-1.5 px-3">Terminal ID</th>
                      <th className="py-1.5 px-3">Equipment Type</th>
                      <th className="py-1.5 px-3">Position X (m)</th>
                      <th className="py-1.5 px-3">Position Y (m)</th>
                      <th className="py-1.5 px-3">Elevation Z (m)</th>
                      <th className="py-1.5 px-3">Functional Duty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reportData.terminal_schedule.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-50/50">
                        <td className="py-1.5 px-3 font-mono font-semibold text-slate-900">
                          {t.id}
                        </td>
                        <td className="py-1.5 px-3 text-slate-700">
                          <span
                            className={`inline-block w-2 h-2 rounded-full mr-1.5 ${
                              t.type.includes('Supply') ? 'bg-sky-500' : 'bg-amber-500'
                            }`}
                          />
                          {t.type}
                        </td>
                        <td className="py-1.5 px-3 font-mono text-slate-600">{t.x.toFixed(2)}</td>
                        <td className="py-1.5 px-3 font-mono text-slate-600">{t.y.toFixed(2)}</td>
                        <td className="py-1.5 px-3 font-mono text-slate-600">{t.z.toFixed(2)}</td>
                        <td className="py-1.5 px-3 text-slate-500 text-[11px]">{t.function}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Section 4: Optimization Candidate Comparison Matrix (if available) */}
            {rankedCandidates.length > 0 && (
              <div className="mb-6">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 mb-2 border-b border-slate-200 pb-1">
                  4. Candidate Layout Comparison Matrix
                </h3>
                <div className="overflow-x-auto border border-slate-200 rounded">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                        <th className="py-1.5 px-3">Rank</th>
                        <th className="py-1.5 px-3">Case ID</th>
                        <th className="py-1.5 px-3">Dataset</th>
                        <th className="py-1.5 px-3">Score</th>
                        <th className="py-1.5 px-3">Sweep %</th>
                        <th className="py-1.5 px-3">Dead Zone %</th>
                        <th className="py-1.5 px-3">Draft Risk %</th>
                        <th className="py-1.5 px-3 text-center">Verdict</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rankedCandidates.slice(0, 5).map((cand, idx) => (
                        <tr
                          key={cand.case}
                          className={
                            cand.case === reportData.case
                              ? 'bg-sky-50/60 font-medium'
                              : 'hover:bg-slate-50/50'
                          }
                        >
                          <td className="py-1.5 px-3 font-semibold text-slate-800">
                            {idx === 0 ? (
                              <span className="text-emerald-700 font-bold">#1 Recom.</span>
                            ) : (
                              `#${idx + 1}`
                            )}
                          </td>
                          <td className="py-1.5 px-3 font-mono text-slate-900">{cand.case}</td>
                          <td className="py-1.5 px-3 text-slate-500">{cand.set}</td>
                          <td className="py-1.5 px-3 font-bold text-slate-900">
                            {cand.score.toFixed(1)}
                          </td>
                          <td className="py-1.5 px-3 text-slate-700">
                            {(cand.kpis.air_sweep_coverage * 100).toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-3 text-slate-700">
                            {(cand.kpis.dead_zone_ratio * 100).toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-3 text-slate-700">
                            {(cand.kpis.draft_risk_ratio * 100).toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-3 text-center">
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                cand.score >= 75
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : cand.score >= 60
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {cand.score >= 75 ? 'PASS' : cand.score >= 60 ? 'COND.' : 'FAIL'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Methodology & Governance Sign-off */}
            <div className="p-4 rounded border border-slate-200 bg-slate-50/80 text-[11px] text-slate-600 space-y-1">
              <div className="font-semibold text-slate-800 uppercase tracking-wide text-[10px]">
                Engineering Methodology & Surrogate Verification Note
              </div>
              <p>
                Calculations generated via Learned Graph Operator (LGO) neural surrogate model
                trained on Navier-Stokes CFD simulations. Air velocities represent steady-state
                vectors evaluated across room coordinate boundaries [0.0m - 8.8m] × [0.0m - 6.1m] ×
                [0.0m - 3.2m].
              </p>
              <div className="pt-2 flex justify-between items-center text-slate-400 text-[10px] border-t border-slate-200">
                <span>
                  Pascal Climate Systems &bull; Confidential &bull; For Engineering Verification
                  Only
                </span>
                <span>Page 1 of 1</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
