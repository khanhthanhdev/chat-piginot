'use client'

import {
  type AnyNode,
  type DuctTerminalNode,
  getCeilingHeightAt,
  getLevelHeight,
  type Space,
  sceneRegistry,
  useScene,
} from '@pascal-app/core'
import * as Select from '@radix-ui/react-select'
import { useFrame } from '@react-three/fiber'
import { Activity, Check, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute, type Group } from 'three'
import { create } from 'zustand'
import { EDITOR_LAYER } from '../../lib/constants'
import useEditor from '../../store/use-editor'

export type CfdMode = 'grid' | 'plane'
type Quality = 'preview' | 'standard' | 'high'
type Grid = {
  dimensions: [number, number, number]
  origin: [number, number, number]
  spacing: [number, number, number]
  indices: number[]
}
export type CfdResult = {
  positions: [number, number, number][]
  speed: number[]
  grid?: Grid
}
type RankedCandidate = {
  id: string
  rank: number
  score?: number
  paretoOptimal?: boolean
  kpis?: {
    ach: number
    meanVelocity: number
    maxVelocity: number
    deadZoneRatio: number
    airSweepCoverage: number
    uniformity: number
  }
  rules?: {
    status: 'pass' | 'warning' | 'fail'
  }
  terminals: Array<{
    id: string
    role: 'supply' | 'return'
    centre: [number, number, number]
    width: number
    depth: number
    rotation: number
  }>
  fieldUrl?: string
  planeUrl?: string
  artifactAvailable: boolean
}
type RoomResult = {
  runId: string
  apiBaseUrl: string
  levelId: string
  baseY: number
  grid: {
    shape: [number, number, number]
    origin: [number, number, number]
    spacing: [number, number, number]
    occupiedPlaneZ: number
  }
  ranking: RankedCandidate[]
  failedCandidates: Array<{ id: string; error: string }>
  selectedCandidateId: string
  views: Record<string, { grid: CfdResult; plane: CfdResult }>
}

type CfdState = {
  apiBaseUrl: string
  projectId: string | null
  results: Record<string, RoomResult>
  failures: Record<string, string>
  progress: Record<
    string,
    { status: string; candidateCount: number; successfulCandidateCount: number }
  >
  running: boolean
  visible: boolean
  mode: CfdMode
  roomFilter: string
  quality: Quality
  density: number
  generation: number
  set: (patch: Partial<CfdState>) => void
  clear: () => void
}

let activeController: AbortController | null = null

function deleteRuns(results: Record<string, RoomResult>) {
  for (const { apiBaseUrl, runId } of Object.values(results))
    void fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/v1/hvac/runs/${runId}`, {
      method: 'DELETE',
      keepalive: true,
    })
}

export const useCfdAnalysis = create<CfdState>((set) => ({
  apiBaseUrl: '',
  projectId: null,
  results: {},
  failures: {},
  progress: {},
  running: false,
  visible: true,
  mode: 'grid',
  roomFilter: 'all',
  quality: 'standard',
  density: 1,
  generation: 0,
  set,
  clear: () => {
    activeController?.abort()
    activeController = null
    deleteRuns(useCfdAnalysis.getState().results)
    set((state) => ({
      results: {},
      failures: {},
      progress: {},
      running: false,
      generation: state.generation + 1,
    }))
  },
}))

function pointInPolygon([x, z]: [number, number], polygon: Array<[number, number]>) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

function levelOffsets(nodes: Record<string, AnyNode>) {
  const levels = Object.values(nodes)
    .filter((node) => node.type === 'level')
    .sort((a, b) => (a as { level: number }).level - (b as { level: number }).level)
  const offsets: Record<string, number> = {}
  let y = 0
  for (const level of levels) {
    offsets[level.id] = y
    y += getLevelHeight(level.id, nodes)
  }
  return offsets
}

export function validateCfdResponse(value: unknown): CfdResult {
  const result = value as CfdResult
  const count = result?.positions?.length
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    result.speed?.length !== count ||
    ![...result.positions.flat(), ...result.speed].every(Number.isFinite)
  )
    throw new Error('Invalid CFD response arrays')
  if (result.grid) {
    const size = result.grid.dimensions.reduce((a, b) => a * b, 1)
    if (
      result.grid.dimensions.some((v) => !Number.isInteger(v) || v < 1) ||
      result.grid.indices.length !== count ||
      result.grid.indices.some((v) => !Number.isInteger(v) || v < 0 || v >= size)
    )
      throw new Error('Invalid CFD response grid')
  }
  return result
}

function endpoint(apiBaseUrl: string, url: string) {
  return new URL(url, `${apiBaseUrl.replace(/\/$/, '')}/`).toString()
}

export function fieldView(bytes: ArrayBuffer, grid: RoomResult['grid'], baseY: number): CfdResult {
  const speed = Array.from(new Float32Array(bytes))
  const expected = grid.shape.reduce((product, value) => product * value, 1)
  if (speed.length !== expected || !speed.every(Number.isFinite))
    throw new Error('Invalid velocity-magnitude field')
  const positions: [number, number, number][] = []
  for (let x = 0; x < grid.shape[0]; x++)
    for (let z = 0; z < grid.shape[1]; z++)
      for (let y = 0; y < grid.shape[2]; y++)
        positions.push([
          grid.origin[0] + grid.spacing[0] * x,
          baseY + grid.origin[2] + grid.spacing[2] * y,
          grid.origin[1] + grid.spacing[1] * z,
        ])
  return validateCfdResponse({
    positions,
    speed,
    grid: {
      dimensions: [grid.shape[0], grid.shape[2], grid.shape[1]],
      origin: [grid.origin[0], baseY + grid.origin[2], grid.origin[1]],
      spacing: [grid.spacing[0], grid.spacing[2], grid.spacing[1]],
      indices: positions.map((_, index) => index),
    },
  })
}

export function planeView(
  occupiedPlane: number[][],
  grid: RoomResult['grid'],
  baseY: number,
): CfdResult {
  if (
    occupiedPlane.length !== grid.shape[0] ||
    occupiedPlane.some(
      (row) => row.length !== grid.shape[1] || row.some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error('Invalid occupied-plane field')
  const positions: [number, number, number][] = []
  const speed: number[] = []
  occupiedPlane.forEach((row, x) => {
    row.forEach((value, z) => {
      positions.push([
        grid.origin[0] + grid.spacing[0] * x,
        baseY + grid.occupiedPlaneZ,
        grid.origin[1] + grid.spacing[1] * z,
      ])
      speed.push(value)
    })
  })
  return validateCfdResponse({ positions, speed })
}

async function fetchCandidateViews(
  apiBaseUrl: string,
  candidate: RankedCandidate,
  grid: RoomResult['grid'],
  baseY: number,
  signal: AbortSignal,
) {
  if (!(candidate.artifactAvailable && candidate.fieldUrl && candidate.planeUrl))
    throw new Error(`Artifacts for candidate '${candidate.id}' are unavailable`)
  const [fieldResponse, planeResponse] = await Promise.all([
    fetch(endpoint(apiBaseUrl, candidate.fieldUrl), { signal }),
    fetch(endpoint(apiBaseUrl, candidate.planeUrl), { signal }),
  ])
  if (!fieldResponse.ok) throw new Error(await fieldResponse.text())
  if (!planeResponse.ok) throw new Error(await planeResponse.text())
  const { occupiedPlane } = (await planeResponse.json()) as { occupiedPlane: number[][] }
  return {
    grid: fieldView(await fieldResponse.arrayBuffer(), grid, baseY),
    plane: planeView(occupiedPlane, grid, baseY),
  }
}

async function runRoom(
  apiBaseUrl: string,
  projectId: string | null,
  space: Space,
  signal: AbortSignal,
  onProgress: (progress: CfdState['progress'][string]) => void,
) {
  const nodes = useScene.getState().nodes as Record<string, AnyNode>
  const offsets = levelOffsets(nodes)
  const baseY = offsets[space.levelId] ?? 0
  const [cx, cz] = space.polygon.reduce(
    ([x, z], p) => [x + p[0] / space.polygon.length, z + p[1] / space.polygon.length],
    [0, 0],
  )
  const height =
    getCeilingHeightAt(space.levelId, nodes, cx, cz) ?? getLevelHeight(space.levelId, nodes)
  const terminals = Object.values(nodes).filter(
    (node): node is DuctTerminalNode =>
      node.type === 'duct-terminal' &&
      node.parentId === space.levelId &&
      pointInPolygon([node.position[0], node.position[2]], space.polygon),
  )
  const supplies = terminals.filter((node) => node.terminalType !== 'return-grille')
  const returns = terminals.filter((node) => node.terminalType === 'return-grille')
  if (supplies.length !== 3 || returns.length !== 3)
    throw new Error('HVAC optimization requires exactly three supplies and three returns')

  const xs = space.polygon.map(([x]) => x)
  const zs = space.polygon.map(([, z]) => z)
  const minimum: [number, number, number] = [Math.min(...xs), Math.min(...zs), 0]
  const maximum: [number, number, number] = [Math.max(...xs), Math.max(...zs), height]
  const length = maximum[0] - minimum[0]
  const width = maximum[1] - minimum[1]
  const centreZ = (minimum[1] + maximum[1]) / 2
  const quality = useCfdAnalysis.getState().quality
  const shape: [number, number, number] =
    quality === 'preview' ? [20, 16, 8] : quality === 'high' ? [50, 40, 20] : [40, 32, 16]
  const spacing: [number, number, number] = [length / shape[0], width / shape[1], height / shape[2]]
  const grid: RoomResult['grid'] = {
    shape,
    origin: [minimum[0] + spacing[0] / 2, minimum[1] + spacing[1] / 2, spacing[2] / 2],
    spacing,
    occupiedPlaneZ: Math.min(1.5, height),
  }
  const terminalSize = (group: DuctTerminalNode[]): [number, number] => [
    group.reduce((sum, node) => sum + node.width, 0) / group.length,
    group.reduce((sum, node) => sum + node.depth, 0) / group.length,
  ]
  const variableRange = (extent: number, offset = false) =>
    offset
      ? { min: -extent / 10, max: extent / 10, step: extent / 10 }
      : { min: extent / 8, max: extent / 4, step: extent / 16 }
  const totalFlowM3s = supplies.reduce(
    (sum, node) => sum + node.airSpeed * node.width * node.depth,
    0,
  )
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/v1/hvac/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      room: { id: `${projectId ?? 'project'}:${space.id}`, minimum, maximum },
      installationLines: {
        supply: {
          start: [minimum[0], centreZ - width / 6, height],
          end: [maximum[0], centreZ - width / 6, height],
          offsetDirection: [0, 1, 0],
        },
        return: {
          start: [minimum[0], centreZ + width / 6, height],
          end: [maximum[0], centreZ + width / 6, height],
          offsetDirection: [0, 1, 0],
        },
      },
      terminalDimensions: { supply: terminalSize(supplies), return: terminalSize(returns) },
      directions: { supply: [0, 0, -1], return: [0, 0, 1] },
      totalFlowM3s,
      minimumClearanceM: 0.1,
      candidateLimit: 100,
      variables: {
        supplySpacingM: variableRange(length),
        supplyOffsetM: variableRange(width, true),
        returnSpacingM: variableRange(length),
        returnOffsetM: variableRange(width, true),
      },
      grid,
    }),
    signal,
  })
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  const { runId } = (await response.json()) as { runId: string }
  signal.addEventListener(
    'abort',
    () => {
      void fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/v1/hvac/runs/${runId}`, {
        method: 'DELETE',
      })
    },
    { once: true },
  )
  while (true) {
    const statusResponse = await fetch(
      `${apiBaseUrl.replace(/\/$/, '')}/api/v1/hvac/runs/${runId}/status`,
      { signal },
    )
    if (!statusResponse.ok) throw new Error(await statusResponse.text())
    const status = (await statusResponse.json()) as {
      status: string
      candidateCount: number
      successfulCandidateCount: number
      errorSummary?: string
    }
    onProgress(status)
    if (status.status === 'failed' || status.status === 'canceled')
      throw new Error(status.errorSummary ?? `Optimization ${status.status}`)
    if (status.status === 'completed') break
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 250)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(signal.reason)
        },
        { once: true },
      )
    })
  }
  const rankingResponse = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/api/v1/hvac/runs/${runId}/ranking`,
    { signal },
  )
  if (!rankingResponse.ok) throw new Error(await rankingResponse.text())
  const rankingResult = (await rankingResponse.json()) as {
    ranking: RankedCandidate[]
    failedCandidates: Array<{ id: string; error: string }>
  }
  const [best] = rankingResult.ranking
  if (!best) throw new Error('Optimization returned no ranked candidate')
  const views = await fetchCandidateViews(apiBaseUrl, best, grid, baseY, signal)
  return {
    runId,
    apiBaseUrl,
    levelId: space.levelId,
    baseY,
    grid,
    ranking: rankingResult.ranking,
    failedCandidates: rankingResult.failedCandidates,
    selectedCandidateId: best.id,
    views: { [best.id]: views },
  }
}

function CandidateSelect({
  candidates,
  onChange,
  value,
}: {
  candidates: RankedCandidate[]
  onChange: (candidateId: string) => void
  value: string
}) {
  const selected = candidates.find((candidate) => candidate.id === value)
  return (
    <Select.Root onValueChange={onChange} value={value}>
      <Select.Trigger
        aria-label="Candidate rank"
        className="flex h-10 w-full items-center gap-2 rounded-lg bg-background/60 px-2.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected?.id}</span>
        <span className="shrink-0 font-medium tabular-nums text-xs">
          {selected?.score?.toFixed(1) ?? '—'}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-xl"
          position="popper"
          sideOffset={6}
        >
          <Select.Viewport className="p-1.5">
            {candidates.map((candidate) => (
              <Select.Item
                className="relative flex h-9 cursor-default select-none items-center gap-2 rounded-lg pr-2 pl-8 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                key={candidate.id}
                value={candidate.id}
              >
                <Select.ItemIndicator className="absolute left-2">
                  <Check className="size-4 text-primary" />
                </Select.ItemIndicator>
                <Select.ItemText>
                  <span className="font-mono text-xs">{candidate.id}</span>
                </Select.ItemText>
                <span className="ml-auto font-medium tabular-nums text-xs">
                  {candidate.score?.toFixed(1) ?? '—'}
                </span>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

export function CfdAnalysisPanel({
  apiBaseUrl,
  projectId,
}: {
  apiBaseUrl: string
  projectId: string | null
}) {
  const state = useCfdAnalysis()
  const spaces = useEditor((s) => s.spaces)
  const run = async (only?: string) => {
    activeController?.abort()
    const controller = new AbortController()
    activeController = controller
    const generation = useCfdAnalysis.getState().generation
    state.set({ running: true })
    for (const space of Object.values(spaces).filter(
      (room) => !room.isExterior && (!only || room.id === only),
    )) {
      try {
        const result = await runRoom(apiBaseUrl, projectId, space, controller.signal, (progress) =>
          useCfdAnalysis.setState((current) => ({
            progress: { ...current.progress, [space.id]: progress },
          })),
        )
        if (result && generation === useCfdAnalysis.getState().generation) {
          const previous = useCfdAnalysis.getState().results[space.id]
          if (previous) deleteRuns({ [space.id]: previous })
          useCfdAnalysis.setState((s) => ({
            results: { ...s.results, [space.id]: result },
            failures: Object.fromEntries(
              Object.entries(s.failures).filter(([id]) => id !== space.id),
            ),
          }))
        }
      } catch (error) {
        if (!controller.signal.aborted && generation === useCfdAnalysis.getState().generation)
          useCfdAnalysis.setState((s) => ({
            failures: {
              ...s.failures,
              [space.id]: error instanceof Error ? error.message : String(error),
            },
          }))
      }
    }
    if (activeController === controller) state.set({ running: false })
  }
  const selectCandidate = async (roomId: string, candidateId: string) => {
    const room = useCfdAnalysis.getState().results[roomId]
    if (!room || room.selectedCandidateId === candidateId) return
    if (room.views[candidateId]) {
      useCfdAnalysis.setState((current) => ({
        results: {
          ...current.results,
          [roomId]: { ...room, selectedCandidateId: candidateId },
        },
      }))
      return
    }
    const candidate = room.ranking.find(({ id }) => id === candidateId)
    if (!candidate) return
    try {
      const views = await fetchCandidateViews(
        room.apiBaseUrl,
        candidate,
        room.grid,
        room.baseY,
        new AbortController().signal,
      )
      useCfdAnalysis.setState((current) => ({
        results: {
          ...current.results,
          [roomId]: {
            ...room,
            selectedCandidateId: candidateId,
            views: Object.fromEntries(
              [...Object.entries(room.views), [candidateId, views]].slice(-2),
            ),
          },
        },
      }))
    } catch (error) {
      useCfdAnalysis.setState((current) => ({
        failures: {
          ...current.failures,
          [roomId]: error instanceof Error ? error.message : String(error),
        },
      }))
    }
  }
  return (
    <div className="space-y-3 p-3 text-sm">
      <div className="flex gap-2">
        <button
          className="rounded bg-accent px-3 py-2"
          disabled={state.running}
          onClick={() => run()}
          type="button"
        >
          Run All
        </button>
        <button
          className="rounded border px-3 py-2"
          disabled={!state.running}
          onClick={() => activeController?.abort()}
          type="button"
        >
          Cancel
        </button>
      </div>
      <label className="flex justify-between">
        Quality
        <select
          value={state.quality}
          onChange={(e) => state.set({ quality: e.target.value as Quality })}
        >
          <option>preview</option>
          <option>standard</option>
          <option>high</option>
        </select>
      </label>
      <label className="flex justify-between">
        Visible
        <input
          checked={state.visible}
          onChange={(e) => state.set({ visible: e.target.checked })}
          type="checkbox"
        />
      </label>
      <label className="flex justify-between">
        Room
        <select
          value={state.roomFilter}
          onChange={(e) => state.set({ roomFilter: e.target.value })}
        >
          <option value="all">All</option>
          {Object.values(spaces)
            .filter((s) => !s.isExterior)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
        </select>
      </label>
      <label className="flex justify-between">
        Display
        <select value={state.mode} onChange={(e) => state.set({ mode: e.target.value as CfdMode })}>
          <option value="grid">Full grid</option>
          <option value="plane">Occupied plane</option>
        </select>
      </label>
      <label>
        Density
        <input
          className="w-full"
          max="1"
          min=".05"
          onChange={(e) => state.set({ density: +e.target.value })}
          step=".05"
          type="range"
          value={state.density}
        />
      </label>
      {Object.entries(state.progress).map(([id, progress]) => (
        <div className="rounded border p-2" key={id}>
          {id}: {progress.status} ({progress.successfulCandidateCount}/{progress.candidateCount})
        </div>
      ))}
      {Object.entries(state.results).map(([roomId, result]) => {
        const candidate = result.ranking.find(({ id }) => id === result.selectedCandidateId)
        return (
          <div className="space-y-3" key={roomId}>
            <div className="space-y-3 rounded-xl bg-card/40 p-3">
              <div className="min-w-0">
                <div className="font-medium text-xs">Candidate rank</div>
                <div className="truncate text-muted-foreground text-xs" title={roomId}>
                  {roomId}
                </div>
              </div>
              <CandidateSelect
                candidates={result.ranking}
                onChange={(candidateId) => void selectCandidate(roomId, candidateId)}
                value={result.selectedCandidateId}
              />
              {result.failedCandidates.map((failedCandidate) => (
                <div className="text-red-500 text-xs" key={failedCandidate.id}>
                  {failedCandidate.id}: {failedCandidate.error}
                </div>
              ))}
            </div>
            {candidate?.kpis && (
              <div className="rounded-xl bg-card/40 p-3">
                <div className="mb-3 font-medium text-xs">Candidate metrics</div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  {[
                    ['Score', candidate.score?.toFixed(1) ?? '—'],
                    ['ACH', candidate.kpis.ach.toFixed(2)],
                    ['Mean speed', `${candidate.kpis.meanVelocity.toFixed(2)} m/s`],
                    ['Max speed', `${candidate.kpis.maxVelocity.toFixed(2)} m/s`],
                    ['Dead zone', `${(candidate.kpis.deadZoneRatio * 100).toFixed(1)}%`],
                    ['Air sweep', `${(candidate.kpis.airSweepCoverage * 100).toFixed(1)}%`],
                    ['Uniformity', `${(candidate.kpis.uniformity * 100).toFixed(1)}%`],
                    ['Rules', candidate.rules?.status ?? '—'],
                    ['Pareto', candidate.paretoOptimal ? 'Optimal' : 'No'],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-medium tabular-nums capitalize">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        )
      })}
      {Object.entries(state.failures).map(([id, error]) => (
        <div className="rounded border border-red-500 p-2" key={id}>
          {id}: {error}
          <button className="ml-2 underline" onClick={() => run(id)} type="button">
            Retry
          </button>
        </div>
      ))}
    </div>
  )
}

export function ConfiguredCfdAnalysisPanel() {
  const apiBaseUrl = useCfdAnalysis((state) => state.apiBaseUrl)
  const projectId = useCfdAnalysis((state) => state.projectId)
  useEffect(() => () => useCfdAnalysis.getState().clear(), [projectId])
  return <CfdAnalysisPanel apiBaseUrl={apiBaseUrl} projectId={projectId} />
}

function ResultPoints({ room }: { room: RoomResult }) {
  const { density, mode } = useCfdAnalysis()
  const geometry = useMemo(() => {
    const result = room.views[room.selectedCandidateId]?.[mode]
    if (!result) return new BufferGeometry()
    const values = result.speed
    const min = Math.min(...values),
      max = Math.max(...values),
      range = max - min || 1
    const positions: number[] = [],
      colors: number[] = []
    const stride = density < 1 ? Math.max(1, Math.round(1 / density)) : 1
    result.positions.forEach((point, i) => {
      if (i % stride !== 0) return
      positions.push(...point)
      const color = new Color().setHSL(0.66 * (1 - (values[i]! - min) / range), 1, 0.5)
      colors.push(color.r, color.g, color.b)
    })
    const value = new BufferGeometry()
    value.setAttribute('position', new Float32BufferAttribute(positions, 3))
    value.setAttribute('color', new Float32BufferAttribute(colors, 3))
    return value
  }, [density, mode, room])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <points geometry={geometry}>
      <pointsMaterial size={mode === 'plane' ? 0.08 : 0.05} vertexColors />
    </points>
  )
}

function RoomVisualization({ room }: { room: RoomResult }) {
  const ref = useRef<Group>(null)
  const candidate = room.ranking.find(({ id }) => id === room.selectedCandidateId)
  useFrame(() => {
    if (!ref.current) return
    const level = sceneRegistry.nodes.get(room.levelId as never)
    ref.current.position.y = (level?.position.y ?? room.baseY) - room.baseY
  })
  return (
    <group ref={ref}>
      <ResultPoints room={room} />
      {candidate?.terminals.map((terminal) => (
        <mesh
          key={terminal.id}
          layers={EDITOR_LAYER}
          position={[
            terminal.centre[0],
            room.baseY + terminal.centre[2] - 0.05,
            terminal.centre[1],
          ]}
          rotation={[0, -terminal.rotation, 0]}
        >
          <boxGeometry args={[terminal.width, 0.06, terminal.depth]} />
          <meshBasicMaterial
            color={terminal.role === 'supply' ? '#2563eb' : '#f97316'}
            depthTest={false}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}
    </group>
  )
}

export function CfdVisualization() {
  const { results, visible, roomFilter } = useCfdAnalysis()
  if (!visible) return null
  return (
    <>
      {Object.entries(results)
        .filter(([id]) => roomFilter === 'all' || id === roomFilter)
        .map(([id, room]) => (
          <RoomVisualization key={id} room={room} />
        ))}
    </>
  )
}

export const cfdTabIcon = <Activity className="h-5 w-5" />
