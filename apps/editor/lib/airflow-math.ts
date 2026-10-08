import type { ComfortMetric, SliceAxis, SliceResult } from './airflow-store'

export function cfdToThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, y]
}

export function threeToCfd(x: number, y: number, z: number): [number, number, number] {
  return [x, z, y]
}

export function calculateDraftRate(v: number, tempC: number, tu = 30): number {
  if (v < 0.05) return 0
  const dr = (34 - tempC) * (v - 0.05) ** 0.62 * (0.37 * v * tu + 3.14)
  return Math.max(0, Math.min(100, dr))
}

export function classifyComfort(v: number, tempK: number): 'comfort' | 'draft' | 'stagnant' {
  if (v < 0.05) return 'stagnant'
  const tempC = tempK - 273.15
  const dr = calculateDraftRate(v, tempC)
  if (v <= 0.2 && tempC >= 23.0 && tempC <= 26.0 && dr <= 15) {
    return 'comfort'
  }
  return 'draft'
}

export function turboRgb(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  const r = Math.round(
    255 *
      Math.max(
        0,
        Math.min(
          1,
          0.1357 + x * (4.5974 - x * (42.3277 - x * (130.5887 - x * (150.5667 - x * 58.1375)))),
        ),
      ),
  )
  const g = Math.round(
    255 *
      Math.max(
        0,
        Math.min(
          1,
          0.0914 + x * (2.1856 + x * (4.8052 - x * (14.0195 + x * (4.2109 - x * 2.7747)))),
        ),
      ),
  )
  const b = Math.round(
    255 *
      Math.max(
        0,
        Math.min(
          1,
          0.1067 + x * (12.5732 - x * (83.585 - x * (236.8897 - x * (304.07 - x * 133.6705)))),
        ),
      ),
  )
  return [r, g, b]
}

export function coolToWarmRgb(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  if (x < 0.33) {
    const f = x / 0.33
    return [
      Math.round(59 + f * (56 - 59)),
      Math.round(130 + f * (189 - 130)),
      Math.round(246 + f * (248 - 246)),
    ]
  }
  if (x < 0.66) {
    const f = (x - 0.33) / 0.33
    return [
      Math.round(56 + f * (251 - 56)),
      Math.round(189 + f * (146 - 189)),
      Math.round(248 + f * (60 - 248)),
    ]
  }
  const f = (x - 0.66) / 0.34
  return [
    Math.round(251 + f * (239 - 251)),
    Math.round(146 + f * (68 - 146)),
    Math.round(60 + f * (68 - 60)),
  ]
}

export function comfortRgb(category: 'comfort' | 'draft' | 'stagnant'): [number, number, number] {
  switch (category) {
    case 'comfort':
      return [34, 197, 94] // #22c55e (Green)
    case 'draft':
      return [59, 130, 246] // #3b82f6 (Blue)
    case 'stagnant':
      return [245, 158, 11] // #f59e0b (Orange)
  }
}

export type SlicePlaneConfig = {
  position: [number, number, number]
  rotation: [number, number, number]
  size: [number, number]
}

export function getSlicePlaneConfig(axis: SliceAxis, value: number): SlicePlaneConfig {
  switch (axis) {
    case 'z':
      return {
        position: [4.4, value, 3.05],
        rotation: [-Math.PI / 2, 0, 0],
        size: [8.8, 6.1],
      }
    case 'x':
      return {
        position: [value, 1.6, 3.05],
        rotation: [0, Math.PI / 2, 0],
        size: [6.1, 3.2],
      }
    case 'y':
      return {
        position: [4.4, 1.6, value],
        rotation: [0, 0, 0],
        size: [8.8, 3.2],
      }
  }
}

export type SliceBufferResult = {
  data: Uint8Array
  width: number
  height: number
  stats: {
    comfortRatio: number
    draftRatio: number
    stagnantRatio: number
  }
}

export function generateSliceRgbaBuffer(
  slice: SliceResult,
  metric: ComfortMetric,
): SliceBufferResult {
  const [rows, columns] = slice.shape
  const data = new Uint8Array(rows * columns * 4)

  let minVal = Number.POSITIVE_INFINITY
  let maxVal = Number.NEGATIVE_INFINITY
  const scalars: number[][] = []

  let comfortCount = 0
  let draftCount = 0
  let stagnantCount = 0
  let totalValid = 0

  for (let r = 0; r < rows; r++) {
    scalars[r] = []
    for (let c = 0; c < columns; c++) {
      let val: number
      if (metric === 'temperature') {
        val = slice.T[r]?.[c] ?? 295.15
      } else {
        const u = slice.u[r]?.[c] ?? 0
        const v = slice.v[r]?.[c] ?? 0
        const w = slice.w[r]?.[c] ?? 0
        val = Math.hypot(u, v, w)
      }
      scalars[r]![c] = val
      if (!Number.isNaN(val)) {
        if (val < minVal) minVal = val
        if (val > maxVal) maxVal = val
      }
    }
  }

  if (minVal === Number.POSITIVE_INFINITY) {
    minVal = 0
    maxVal = 1
  }
  const range = maxVal > minVal ? maxVal - minVal : 1

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const idx = (c * rows + r) * 4
      const val = scalars[r]![c]!
      let rgb: [number, number, number]

      if (metric === 'comfort') {
        const u = slice.u[r]?.[c] ?? 0
        const v = slice.v[r]?.[c] ?? 0
        const w = slice.w[r]?.[c] ?? 0
        const speed = Math.hypot(u, v, w)
        const tempK = slice.T[r]?.[c] ?? 295.15
        const category = classifyComfort(speed, tempK)
        rgb = comfortRgb(category)

        totalValid++
        if (category === 'comfort') comfortCount++
        else if (category === 'draft') draftCount++
        else stagnantCount++
      } else if (metric === 'temperature') {
        const norm = (val - minVal) / range
        rgb = coolToWarmRgb(norm)
      } else {
        const norm = (val - minVal) / range
        rgb = turboRgb(norm)
      }

      data[idx + 0] = rgb[0]
      data[idx + 1] = rgb[1]
      data[idx + 2] = rgb[2]
      data[idx + 3] = 255
    }
  }

  return {
    data,
    width: rows,
    height: columns,
    stats: {
      comfortRatio: totalValid > 0 ? comfortCount / totalValid : 0,
      draftRatio: totalValid > 0 ? draftCount / totalValid : 0,
      stagnantRatio: totalValid > 0 ? stagnantCount / totalValid : 0,
    },
  }
}

export type VectorGrid3D = {
  xs: number[]
  ys: number[]
  zs: number[]
  // Indexed by [ix][iy][iz]
  u: number[][][]
  v: number[][][]
  w: number[][][]
}

export function generateSampleGridPoints(
  nx = 11,
  ny = 8,
  nz = 5,
): { points: [number, number, number][]; xs: number[]; ys: number[]; zs: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []

  for (let i = 0; i < nx; i++) xs.push(0.4 + (i * (8.4 - 0.4)) / (nx - 1))
  for (let j = 0; j < ny; j++) ys.push(0.4 + (j * (5.7 - 0.4)) / (ny - 1))
  for (let k = 0; k < nz; k++) zs.push(0.4 + (k * (2.8 - 0.4)) / (nz - 1))

  const points: [number, number, number][] = []
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        points.push([Number(x.toFixed(4)), Number(y.toFixed(4)), Number(z.toFixed(4))])
      }
    }
  }
  return { points, xs, ys, zs }
}

export function buildVectorGrid(
  xs: number[],
  ys: number[],
  zs: number[],
  uArr: (number | null | undefined)[],
  vArr: (number | null | undefined)[],
  wArr: (number | null | undefined)[],
): VectorGrid3D {
  const nx = xs.length
  const ny = ys.length
  const nz = zs.length

  const u: number[][][] = []
  const v: number[][][] = []
  const w: number[][][] = []

  let idx = 0
  for (let i = 0; i < nx; i++) {
    u[i] = []
    v[i] = []
    w[i] = []
    for (let j = 0; j < ny; j++) {
      u[i]![j] = []
      v[i]![j] = []
      w[i]![j] = []
      for (let k = 0; k < nz; k++) {
        u[i]![j]![k] = uArr[idx] ?? 0
        v[i]![j]![k] = vArr[idx] ?? 0
        w[i]![j]![k] = wArr[idx] ?? 0
        idx++
      }
    }
  }

  return { xs, ys, zs, u, v, w }
}

export function interpolateVectorField(
  grid: VectorGrid3D,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const { xs, ys, zs, u, v, w } = grid
  const nx = xs.length
  const ny = ys.length
  const nz = zs.length
  if (nx === 0 || ny === 0 || nz === 0) return [0, 0, 0]

  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val))
  const cx = clamp(x, xs[0]!, xs[nx - 1]!)
  const cy = clamp(y, ys[0]!, ys[ny - 1]!)
  const cz = clamp(z, zs[0]!, zs[nz - 1]!)

  let i = 0
  while (i < nx - 2 && xs[i + 1]! <= cx) i++
  let j = 0
  while (j < ny - 2 && ys[j + 1]! <= cy) j++
  let k = 0
  while (k < nz - 2 && zs[k + 1]! <= cz) k++

  const x0 = xs[i]!
  const x1 = xs[i + 1]!
  const y0 = ys[j]!
  const y1 = ys[j + 1]!
  const z0 = zs[k]!
  const z1 = zs[k + 1]!

  const tx = x1 > x0 ? (cx - x0) / (x1 - x0) : 0
  const ty = y1 > y0 ? (cy - y0) / (y1 - y0) : 0
  const tz = z1 > z0 ? (cz - z0) / (z1 - z0) : 0

  const trilinear = (arr: number[][][]) => {
    const c000 = arr[i]?.[j]?.[k] ?? 0
    const c100 = arr[i + 1]?.[j]?.[k] ?? 0
    const c010 = arr[i]?.[j + 1]?.[k] ?? 0
    const c110 = arr[i + 1]?.[j + 1]?.[k] ?? 0
    const c001 = arr[i]?.[j]?.[k + 1] ?? 0
    const c101 = arr[i + 1]?.[j]?.[k + 1] ?? 0
    const c011 = arr[i]?.[j + 1]?.[k + 1] ?? 0
    const c111 = arr[i + 1]?.[j + 1]?.[k + 1] ?? 0

    const c00 = c000 * (1 - tx) + c100 * tx
    const c10 = c010 * (1 - tx) + c110 * tx
    const c01 = c001 * (1 - tx) + c101 * tx
    const c11 = c011 * (1 - tx) + c111 * tx

    const c0 = c00 * (1 - ty) + c10 * ty
    const c1 = c01 * (1 - ty) + c11 * ty

    return c0 * (1 - tz) + c1 * tz
  }

  return [trilinear(u), trilinear(v), trilinear(w)]
}

export function createDefaultVectorField(
  supplyVents: [number, number][],
  returnVents: [number, number][],
  nx = 11,
  ny = 8,
  nz = 5,
): VectorGrid3D {
  const { xs, ys, zs } = generateSampleGridPoints(nx, ny, nz)
  const u: number[][][] = []
  const v: number[][][] = []
  const w: number[][][] = []

  for (let i = 0; i < nx; i++) {
    u[i] = []
    v[i] = []
    w[i] = []
    const x = xs[i]!
    for (let j = 0; j < ny; j++) {
      u[i]![j] = []
      v[i]![j] = []
      w[i]![j] = []
      const y = ys[j]!
      for (let k = 0; k < nz; k++) {
        const z = zs[k]!
        let vx = 0
        let vy = 0
        let vz = 0

        // Influence from supply vents: downward jet (-z) spreading radially
        for (const [sx, sy] of supplyVents) {
          const dx = x - sx
          const dy = y - sy
          const distSq = dx * dx + dy * dy + 0.04
          const decay = Math.exp(-distSq / 1.5)
          const zFactor = Math.max(0.1, z / 3.2)
          vz -= 0.6 * decay * zFactor
          vx += 0.25 * (dx / Math.sqrt(distSq)) * decay
          vy += 0.25 * (dy / Math.sqrt(distSq)) * decay
        }

        // Influence from return vents: suction towards return vents near ceiling
        for (const [rx, ry] of returnVents) {
          const dx = rx - x
          const dy = ry - y
          const distSq = dx * dx + dy * dy + 0.04
          const decay = Math.exp(-distSq / 2.0)
          const zFactor = Math.max(0.1, z / 3.2)
          vz += 0.2 * decay * zFactor
          vx += 0.15 * (dx / Math.sqrt(distSq)) * decay
          vy += 0.15 * (dy / Math.sqrt(distSq)) * decay
        }

        u[i]![j]![k] = vx
        v[i]![j]![k] = vy
        w[i]![j]![k] = vz
      }
    }
  }

  return { xs, ys, zs, u, v, w }
}
