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
import { useFrame } from '@react-three/fiber'
import { Activity } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute, type Group } from 'three'
import { create } from 'zustand'
import useEditor from '../../store/use-editor'

export type CfdMode = 'points' | 'vectors' | 'particles' | 'streamlines' | 'slice'
type Quality = 'preview' | 'standard' | 'high'
type Grid = {
  dimensions: [number, number, number]
  origin: [number, number, number]
  spacing: [number, number, number]
  indices: number[]
}
export type CfdResult = {
  positions: [number, number, number][]
  velocities: [number, number, number][]
  pressure: number[]
  speed: number[]
  grid?: Grid
}
type RoomResult = { levelId: string; baseY: number; result: CfdResult }

type CfdState = {
  apiBaseUrl: string
  projectId: string | null
  results: Record<string, RoomResult>
  failures: Record<string, string>
  running: boolean
  visible: boolean
  mode: CfdMode
  metric: 'speed' | 'pressure'
  roomFilter: string
  quality: Quality
  density: number
  scale: number
  sliceAxis: 0 | 1 | 2
  slicePosition: number
  generation: number
  set: (patch: Partial<CfdState>) => void
  clear: () => void
}

let activeController: AbortController | null = null

export const useCfdAnalysis = create<CfdState>((set) => ({
  apiBaseUrl: '',
  projectId: null,
  results: {},
  failures: {},
  running: false,
  visible: true,
  mode: 'points',
  metric: 'speed',
  roomFilter: 'all',
  quality: 'standard',
  density: 1,
  scale: 1,
  sliceAxis: 1,
  slicePosition: 0.5,
  generation: 0,
  set,
  clear: () => {
    activeController?.abort()
    activeController = null
    set((state) => ({
      results: {},
      failures: {},
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
    result.velocities?.length !== count ||
    result.pressure?.length !== count ||
    result.speed?.length !== count ||
    ![
      ...result.positions.flat(),
      ...result.velocities.flat(),
      ...result.pressure,
      ...result.speed,
    ].every(Number.isFinite)
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

async function runRoom(
  apiBaseUrl: string,
  projectId: string | null,
  space: Space,
  signal: AbortSignal,
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
      grid: {
        shape,
        origin: [minimum[0] + spacing[0] / 2, minimum[1] + spacing[1] / 2, spacing[2] / 2],
        spacing,
        occupiedPlaneZ: Math.min(1.5, height),
      },
    }),
    signal,
  })
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  const { runId } = (await response.json()) as { runId: string }
  signal.addEventListener(
    'abort',
    () => {
      void fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/v1/hvac/runs/${runId}/cancel`, {
        method: 'POST',
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
    const status = (await statusResponse.json()) as { status: string; errorSummary?: string }
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
  const [best] = (await rankingResponse.json()) as Array<{ id: string }>
  if (!best) throw new Error('Optimization returned no ranked candidate')
  const fieldResponse = await fetch(
    `${apiBaseUrl.replace(/\/$/, '')}/api/v1/hvac/runs/${runId}/candidates/${best.id}/field`,
    { signal },
  )
  if (!fieldResponse.ok) throw new Error(await fieldResponse.text())
  const speed = Array.from(new Float32Array(await fieldResponse.arrayBuffer()))
  const positions: [number, number, number][] = []
  for (let x = 0; x < shape[0]; x++)
    for (let z = 0; z < shape[1]; z++)
      for (let y = 0; y < shape[2]; y++)
        positions.push([
          minimum[0] + spacing[0] * (x + 0.5),
          baseY + spacing[2] * (y + 0.5),
          minimum[1] + spacing[1] * (z + 0.5),
        ])
  return {
    levelId: space.levelId,
    baseY,
    result: validateCfdResponse({
      positions,
      velocities: positions.map(() => [0, 0, 0]),
      pressure: positions.map(() => 0),
      speed,
      grid: {
        dimensions: [shape[0], shape[2], shape[1]],
        origin: [minimum[0] + spacing[0] / 2, baseY + spacing[2] / 2, minimum[1] + spacing[1] / 2],
        spacing: [spacing[0], spacing[2], spacing[1]],
        indices: positions.map((_, index) => index),
      },
    }),
  }
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
        const result = await runRoom(apiBaseUrl, projectId, space, controller.signal)
        if (result && generation === useCfdAnalysis.getState().generation)
          useCfdAnalysis.setState((s) => ({
            results: { ...s.results, [space.id]: result },
            failures: Object.fromEntries(
              Object.entries(s.failures).filter(([id]) => id !== space.id),
            ),
          }))
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
          {['points', 'vectors', 'particles', 'streamlines', 'slice'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label className="flex justify-between">
        Metric
        <select
          value={state.metric}
          onChange={(e) => state.set({ metric: e.target.value as 'speed' | 'pressure' })}
        >
          <option>speed</option>
          <option>pressure</option>
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
      <label>
        Scale
        <input
          className="w-full"
          max="3"
          min=".1"
          onChange={(e) => state.set({ scale: +e.target.value })}
          step=".1"
          type="range"
          value={state.scale}
        />
      </label>
      {state.mode === 'slice' && (
        <>
          <label className="flex justify-between">
            Axis
            <select
              value={state.sliceAxis}
              onChange={(e) => state.set({ sliceAxis: +e.target.value as 0 | 1 | 2 })}
            >
              <option value="0">X</option>
              <option value="1">Y</option>
              <option value="2">Z</option>
            </select>
          </label>
          <input
            className="w-full"
            max="1"
            min="0"
            onChange={(e) => state.set({ slicePosition: +e.target.value })}
            step=".01"
            type="range"
            value={state.slicePosition}
          />
        </>
      )}
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
  return <CfdAnalysisPanel apiBaseUrl={apiBaseUrl} projectId={projectId} />
}

function ResultPoints({ room }: { room: RoomResult }) {
  const { metric, density, mode, sliceAxis, slicePosition, scale } = useCfdAnalysis()
  const geometry = useMemo(() => {
    const values = room.result[metric]
    const min = Math.min(...values),
      max = Math.max(...values),
      range = max - min || 1
    const positions: number[] = [],
      colors: number[] = []
    const stride = density < 1 ? Math.max(1, Math.round(1 / density)) : 1
    room.result.positions.forEach((point, i) => {
      if (i % stride !== 0) return
      if (mode === 'slice') {
        const bounds = room.result.grid
        if (!bounds) return
        const axisMin = bounds.origin[sliceAxis],
          axisMax = axisMin + bounds.spacing[sliceAxis] * (bounds.dimensions[sliceAxis] - 1)
        if (
          Math.abs((point[sliceAxis] - axisMin) / (axisMax - axisMin || 1) - slicePosition) > 0.04
        )
          return
      }
      const velocity = room.result.velocities[i]!
      const repeats = mode === 'vectors' ? 2 : mode === 'streamlines' ? 5 : 1
      for (let step = 0; step < repeats; step++) {
        const t = mode === 'points' || mode === 'slice' ? 0 : step * 0.08 * scale
        positions.push(
          point[0] + velocity[0] * t,
          point[1] + velocity[1] * t,
          point[2] + velocity[2] * t,
        )
        const color = new Color().setHSL(0.66 * (1 - (values[i]! - min) / range), 1, 0.5)
        colors.push(color.r, color.g, color.b)
      }
    })
    const value = new BufferGeometry()
    value.setAttribute('position', new Float32BufferAttribute(positions, 3))
    value.setAttribute('color', new Float32BufferAttribute(colors, 3))
    return value
  }, [density, metric, mode, room, scale, sliceAxis, slicePosition])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <points geometry={geometry}>
      <pointsMaterial size={0.05 * scale} vertexColors />
    </points>
  )
}

function RoomVisualization({ room }: { room: RoomResult }) {
  const ref = useRef<Group>(null)
  const mode = useCfdAnalysis((s) => s.mode)
  useFrame((state) => {
    if (!ref.current) return
    const level = sceneRegistry.nodes.get(room.levelId as never)
    ref.current.position.y = (level?.position.y ?? room.baseY) - room.baseY
    if (mode === 'particles') ref.current.rotation.y = Math.sin(state.clock.elapsedTime) * 0.002
  })
  return (
    <group ref={ref}>
      <ResultPoints room={room} />
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
