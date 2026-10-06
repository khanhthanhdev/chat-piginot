'use client'

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useAirflowStore } from '@/lib/airflow-store'

function heatColor(value: number, minimum: number, maximum: number) {
  const amount = maximum > minimum ? (value - minimum) / (maximum - minimum) : 0.5
  const clamped = Math.max(0, Math.min(1, amount))
  return `hsl(${240 - clamped * 240} 85% 50%)`
}

export function AirflowSceneOverlay() {
  const details = useAirflowStore((s) => s.details)
  const sliceResult = useAirflowStore((s) => s.sliceResult)
  const sliceHeight = useAirflowStore((s) => s.sliceHeight)
  const metric = useAirflowStore((s) => s.metric)
  const show3DSlice = useAirflowStore((s) => s.show3DSlice)
  const sliceOpacity = useAirflowStore((s) => s.sliceOpacity)

  // Room envelope wireframe: 8.8m (X) x 3.2m (Y) x 6.1m (Z) centered at (4.4, 1.6, 3.05)
  const edgesGeometry = useMemo(() => {
    const box = new THREE.BoxGeometry(8.8, 3.2, 6.1)
    const edges = new THREE.EdgesGeometry(box)
    box.dispose()
    return edges
  }, [])

  useEffect(() => {
    return () => {
      edgesGeometry.dispose()
    }
  }, [edgesGeometry])

  // Canvas texture generation for the 2D slice plane
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textureRef = useRef<THREE.CanvasTexture | null>(null)

  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas')
    }
    const tex = new THREE.CanvasTexture(canvasRef.current)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    textureRef.current = tex
    return tex
  }, [])

  useEffect(() => {
    return () => {
      textureRef.current?.dispose()
    }
  }, [])

  // Update canvas texture whenever slice data or display metric changes
  useEffect(() => {
    if (!sliceResult || !canvasRef.current || !textureRef.current) return

    const [rows, columns] = sliceResult.shape
    const canvas = canvasRef.current
    canvas.width = rows
    canvas.height = columns
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Calculate scalar field
    const values: number[][] = []
    let minimum = Number.POSITIVE_INFINITY
    let maximum = Number.NEGATIVE_INFINITY

    for (let i = 0; i < rows; i++) {
      values[i] = []
      for (let j = 0; j < columns; j++) {
        let val: number
        if (metric === 'temperature') {
          val = sliceResult.T[i]?.[j] ?? 0
        } else {
          const u = sliceResult.u[i]?.[j] ?? 0
          const v = sliceResult.v[i]?.[j] ?? 0
          const w = sliceResult.w[i]?.[j] ?? 0
          val = Math.hypot(u, v, w)
        }
        values[i]![j] = val
        if (val < minimum) minimum = val
        if (val > maximum) maximum = val
      }
    }

    // Paint scalar grid to canvas
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < columns; j++) {
        const val = values[i]![j]!
        ctx.fillStyle = heatColor(val, minimum, maximum)
        ctx.fillRect(i, j, 1, 1)
      }
    }

    textureRef.current.needsUpdate = true
  }, [sliceResult, metric])

  if (!details) {
    return null
  }

  return (
    <group name="airflow-scene-overlay">
      {/* Room boundary guide */}
      <lineSegments geometry={edgesGeometry} position={[4.4, 1.6, 3.05]}>
        <lineBasicMaterial color="#38bdf8" opacity={0.25} transparent />
      </lineSegments>

      {/* Ceiling Supply Vents (Blue diffusers with directional arrow) */}
      {details.supply_vents_xy.map(([x, y], idx) => (
        <group key={`supply-vent-${idx}`} position={[x, 3.2, y]}>
          <mesh position={[0, -0.025, 0]}>
            <cylinderGeometry args={[0.22, 0.22, 0.05, 16]} />
            <meshStandardMaterial color="#0284c7" />
          </mesh>
          <mesh position={[0, -0.12, 0]}>
            <cylinderGeometry args={[0.025, 0.025, 0.14, 8]} />
            <meshStandardMaterial color="#0284c7" />
          </mesh>
          <mesh position={[0, -0.22, 0]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.07, 0.1, 8]} />
            <meshStandardMaterial color="#0284c7" />
          </mesh>
        </group>
      ))}

      {/* Ceiling Return Vents (Orange grilles) */}
      {details.return_vents_xy.map(([x, y], idx) => (
        <group key={`return-vent-${idx}`} position={[x, 3.2, y]}>
          <mesh position={[0, -0.025, 0]}>
            <cylinderGeometry args={[0.22, 0.22, 0.05, 16]} />
            <meshStandardMaterial color="#f97316" />
          </mesh>
        </group>
      ))}

      {/* 3D Flow Slice Plane */}
      {sliceResult && show3DSlice && texture && (
        <mesh position={[4.4, sliceHeight, 3.05]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[8.8, 6.1]} />
          <meshBasicMaterial
            depthWrite={false}
            map={texture}
            opacity={sliceOpacity}
            side={THREE.DoubleSide}
            transparent
          />
        </mesh>
      )}
    </group>
  )
}
