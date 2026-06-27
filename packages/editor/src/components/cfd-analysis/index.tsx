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
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  type Group,
  Quaternion,
  ShapeUtils,
  Vector3,
} from 'three'
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

export function roomStl(polygon: Array<[number, number]>, floorY: number, height: number) {
  const triangles = ShapeUtils.triangulateShape(
    polygon.map(([x, z]) => ({ x, y: z })),
    [],
  )
  const faces: Array<
    [[number, number, number], [number, number, number], [number, number, number]]
  > = []
  for (const triangle of triangles) {
    const a = triangle[0]!
    const b = triangle[1]!
    const c = triangle[2]!
    faces.push(
      [
        [polygon[c]![0], floorY, polygon[c]![1]],
        [polygon[b]![0], floorY, polygon[b]![1]],
        [polygon[a]![0], floorY, polygon[a]![1]],
      ],
      [
        [polygon[a]![0], floorY + height, polygon[a]![1]],
        [polygon[b]![0], floorY + height, polygon[b]![1]],
        [polygon[c]![0], floorY + height, polygon[c]![1]],
      ],
    )
  }
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length]!
    faces.push(
      [
        [a[0], floorY, a[1]],
        [b[0], floorY, b[1]],
        [b[0], floorY + height, b[1]],
      ],
      [
        [a[0], floorY, a[1]],
        [b[0], floorY + height, b[1]],
        [a[0], floorY + height, a[1]],
      ],
    )
  })
  return new Blob(
    [
      `solid room\n${faces
        .map(
          (face) =>
            `facet normal 0 0 0\nouter loop\n${face.map((v) => `vertex ${v.join(' ')}`).join('\n')}\nendloop\nendfacet`,
        )
        .join('\n')}\nendsolid room`,
    ],
    { type: 'model/stl' },
  )
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

function terminalDirection(node: DuctTerminalNode): [number, number, number] {
  // Air-out (face-normal) direction in level-local space, matching the node's
  // mount convention: floor +Y, ceiling -Y (blows down into the room), wall +Z.
  const direction =
    node.mount === 'ceiling'
      ? new Vector3(0, -1, 0)
      : node.mount === 'wall'
        ? new Vector3(0, 0, 1)
        : new Vector3(0, 1, 0)
  direction.applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), node.rotation))
  return [direction.x, direction.y, direction.z]
}

const MAX_RATE_LIMIT_RETRIES = 5

async function runRoom(
  apiBaseUrl: string,
  projectId: string | null,
  space: Space,
  signal: AbortSignal,
  attempt = 0,
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
  if (
    !terminals.some((node) => node.terminalType !== 'return-grille') ||
    !terminals.some((node) => node.terminalType === 'return-grille')
  )
    return null
  const form = new FormData()
  form.append('meshFile', roomStl(space.polygon, baseY, height), `${space.id}.stl`)
  form.append(
    'diffusers',
    JSON.stringify(
      terminals.map((node) => ({
        id: node.id,
        kind: node.terminalType === 'return-grille' ? 'return' : 'supply',
        center: [node.position[0], baseY + node.position[1], node.position[2]],
        ...(node.terminalType === 'return-grille'
          ? {}
          : {
              direction: terminalDirection(node),
              airflowRate: (node as DuctTerminalNode & { airSpeed?: number }).airSpeed ?? 1,
            }),
      })),
    ),
  )
  form.append(
    'options',
    JSON.stringify({ quality: useCfdAnalysis.getState().quality, returnGrid3D: true }),
  )
  form.append('context', JSON.stringify({ projectId, levelId: space.levelId, zoneId: space.id }))
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/hvac-inference-mesh`, {
    method: 'POST',
    body: form,
    signal,
  })
  if (response.status === 429) {
    if (attempt >= MAX_RATE_LIMIT_RETRIES)
      throw new Error('Rate limited — too many retries, try again later')
    const delay = Number(response.headers.get('retry-after') ?? 1) * 1000
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      })
    })
    return runRoom(apiBaseUrl, projectId, space, signal, attempt + 1)
  }
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  return { levelId: space.levelId, baseY, result: validateCfdResponse(await response.json()) }
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
