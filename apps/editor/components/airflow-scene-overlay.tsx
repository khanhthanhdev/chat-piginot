'use client'

import { EDITOR_LAYER } from '@pascal-app/editor'
import { Html } from '@react-three/drei'
import { type ThreeEvent, useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  buildVectorGrid,
  cfdToThree,
  classifyComfort,
  createDefaultVectorField,
  generateSampleGridPoints,
  generateSliceRgbaBuffer,
  getSlicePlaneConfig,
  interpolateVectorField,
  turboRgb,
  type VectorGrid3D,
} from '@/lib/airflow-math'
import { type CaseDetails, useAirflowStore, type VirtualSensor } from '@/lib/airflow-store'

const PARTICLE_COUNT = 800

type Particle = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  age: number
  maxLife: number
}

function ParticleStreamlines({ details }: { details: CaseDetails }) {
  const selectedCase = useAirflowStore((s) => s.selectedCase)
  const selectedModel = useAirflowStore((s) => s.selectedModel)
  const particleSpeed = useAirflowStore((s) => s.particleSpeed)
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const vectorGridRef = useRef<VectorGrid3D>(
    createDefaultVectorField(details.supply_vents_xy, details.return_vents_xy),
  )
  const particlesRef = useRef<Particle[]>([])

  useEffect(() => {
    const vents = details.supply_vents_xy
    if (!vents || vents.length === 0) return
    const parts: Particle[] = []
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const vent = vents[Math.floor(Math.random() * vents.length)]!
      const maxLife = 3.0 + Math.random() * 4.0
      parts.push({
        x: vent[0] + (Math.random() - 0.5) * 0.4,
        y: 3.12,
        z: vent[1] + (Math.random() - 0.5) * 0.4,
        vx: 0,
        vy: -0.4,
        vz: 0,
        age: Math.random() * maxLife,
        maxLife,
      })
    }
    particlesRef.current = parts
  }, [details.supply_vents_xy])

  useEffect(() => {
    if (!selectedCase || !selectedModel) return
    const sample = generateSampleGridPoints(11, 8, 5)
    let active = true

    fetch('/api/airflow/predict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        case: selectedCase,
        run: selectedModel,
        points: sample.points,
        outside: 'nan',
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch grid')
        return res.json()
      })
      .then((data: { u?: (number | null)[]; v?: (number | null)[]; w?: (number | null)[] }) => {
        if (!active || !data.u || !data.v || !data.w) return
        vectorGridRef.current = buildVectorGrid(
          sample.xs,
          sample.ys,
          sample.zs,
          data.u,
          data.v,
          data.w,
        )
      })
      .catch(() => {
        if (active) {
          vectorGridRef.current = createDefaultVectorField(
            details.supply_vents_xy,
            details.return_vents_xy,
          )
        }
      })

    return () => {
      active = false
    }
  }, [selectedCase, selectedModel, details.supply_vents_xy, details.return_vents_xy])

  const dummy = useMemo(() => new THREE.Object3D(), [])
  const color = useMemo(() => new THREE.Color(), [])
  const upVec = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const dirVec = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, delta) => {
    const mesh = meshRef.current
    if (!mesh) return
    const grid = vectorGridRef.current
    const vents = details.supply_vents_xy
    if (!vents || vents.length === 0) return

    const dt = Math.min(delta, 0.05) * particleSpeed
    const particles = particlesRef.current

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!
      const [u, v, w] = interpolateVectorField(grid, p.x, p.z, p.y)

      p.vx = u
      p.vy = w
      p.vz = v

      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.age += delta

      if (
        p.x < 0.05 ||
        p.x > 8.75 ||
        p.y < 0.05 ||
        p.y > 3.15 ||
        p.z < 0.05 ||
        p.z > 6.05 ||
        p.age >= p.maxLife
      ) {
        const vent = vents[Math.floor(Math.random() * vents.length)]!
        p.x = vent[0] + (Math.random() - 0.5) * 0.4
        p.y = 3.12
        p.z = vent[1] + (Math.random() - 0.5) * 0.4
        p.age = 0
        p.maxLife = 3.0 + Math.random() * 4.0
      }

      const speed = Math.hypot(p.vx, p.vy, p.vz)
      dirVec.set(p.vx, p.vy, p.vz)
      if (dirVec.lengthSq() > 1e-5) {
        dirVec.normalize()
        dummy.quaternion.setFromUnitVectors(upVec, dirVec)
      } else {
        dummy.quaternion.identity()
      }

      dummy.position.set(p.x, p.y, p.z)
      dummy.scale.set(1, Math.min(2.5, 0.5 + speed * 3.5), 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)

      const [r, g, b] = turboRgb(Math.min(1, speed / 0.6))
      color.setRGB(r / 255, g / 255, b / 255)
      mesh.setColorAt(i, color)
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, PARTICLE_COUNT]}
      frustumCulled={false}
      layers={EDITOR_LAYER}
    >
      <cylinderGeometry args={[0.018, 0.018, 0.1, 6]} />
      <meshBasicMaterial transparent opacity={0.85} />
    </instancedMesh>
  )
}
export function AirflowSceneOverlay() {
  const details = useAirflowStore((s) => s.details)
  const sliceResult = useAirflowStore((s) => s.sliceResult)
  const sliceAxis = useAirflowStore((s) => s.sliceAxis)
  const sliceValue = useAirflowStore((s) => s.sliceValue)
  const metric = useAirflowStore((s) => s.metric)
  const show3DSlice = useAirflowStore((s) => s.show3DSlice)
  const sliceOpacity = useAirflowStore((s) => s.sliceOpacity)
  const showParticles = useAirflowStore((s) => s.showParticles)
  const isProbingActive = useAirflowStore((s) => s.isProbingActive)
  const probePoint = useAirflowStore((s) => s.probePoint)
  const setProbePoint = useAirflowStore((s) => s.setProbePoint)
  const virtualSensors = useAirflowStore((s) => s.virtualSensors)
  const addVirtualSensor = useAirflowStore((s) => s.addVirtualSensor)
  const removeVirtualSensor = useAirflowStore((s) => s.removeVirtualSensor)
  const selectedCase = useAirflowStore((s) => s.selectedCase)
  const selectedModel = useAirflowStore((s) => s.selectedModel)

  const [texture, setTexture] = useState<THREE.DataTexture | null>(null)
  const textureRef = useRef<THREE.DataTexture | null>(null)
  const probeTimerRef = useRef<NodeJS.Timeout | null>(null)
  const probeAbortRef = useRef<AbortController | null>(null)
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

  // Generate hardware-filtered DataTexture on sliceResult or metric change
  useEffect(() => {
    if (!sliceResult) {
      if (textureRef.current) {
        textureRef.current.dispose()
        textureRef.current = null
      }
      setTexture(null)
      return
    }

    const buffer = generateSliceRgbaBuffer(sliceResult, metric)
    const dataTex = new THREE.DataTexture(
      buffer.data,
      buffer.width,
      buffer.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    )
    dataTex.minFilter = THREE.LinearFilter
    dataTex.magFilter = THREE.LinearFilter
    dataTex.generateMipmaps = false
    dataTex.needsUpdate = true

    if (textureRef.current) {
      textureRef.current.dispose()
    }
    textureRef.current = dataTex
    setTexture(dataTex)
  }, [sliceResult, metric])

  useEffect(() => {
    return () => {
      if (textureRef.current) {
        textureRef.current.dispose()
        textureRef.current = null
      }
    }
  }, [])

  const planeConfig = useMemo(() => {
    return getSlicePlaneConfig(sliceAxis, sliceValue)
  }, [sliceAxis, sliceValue])

  const probePlanePosition = useMemo((): [number, number, number] => {
    const [x, y, z] = planeConfig.position
    if (sliceAxis === 'z') return [x, y + 0.001, z]
    if (sliceAxis === 'x') return [x + 0.001, y, z]
    return [x, y, z + 0.001]
  }, [planeConfig.position, sliceAxis])
  // Handle pointer hover on interactive slicing plane for probing
  const handlePointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (!isProbingActive || !details) return
      event.stopPropagation()

      const pt = event.point
      const cfdX = Math.max(0.05, Math.min(8.75, pt.x))
      const cfdY = Math.max(0.05, Math.min(6.05, pt.z))
      const cfdZ = Math.max(0.05, Math.min(3.15, pt.y))

      clearTimeout(probeTimerRef.current ?? undefined)
      if (probeAbortRef.current) {
        probeAbortRef.current.abort()
        probeAbortRef.current = null
      }
      probeTimerRef.current = setTimeout(() => {
        if (!selectedCase || !selectedModel) return
        const controller = new AbortController()
        probeAbortRef.current = controller
        fetch('/api/airflow/predict', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            case: selectedCase,
            run: selectedModel,
            points: [[cfdX, cfdY, cfdZ]],
            outside: 'nan',
          }),
        })
          .then((res) => (res.ok ? res.json() : null))
          .then(
            (
              data: {
                u?: (number | null)[]
                v?: (number | null)[]
                w?: (number | null)[]
                T?: (number | null)[]
              } | null,
            ) => {
              if (data?.u?.[0] === undefined || data.u[0] === null) return
              const u = data.u[0] ?? 0
              const v = data.v?.[0] ?? 0
              const w = data.w?.[0] ?? 0
              const T = data.T?.[0] ?? 295.15
              const velocity = Math.hypot(u, v, w)
              const comfortCategory = classifyComfort(velocity, T)
              setProbePoint({
                position: [cfdX, cfdY, cfdZ],
                u,
                v,
                w,
                velocity,
                T,
                tempC: T - 273.15,
                comfortCategory,
              })
            },
          )
          .catch((err) => {
            if (err?.name !== 'AbortError') {
              // ignore aborted requests
            }
          })
      }, 60)
    },
    [isProbingActive, details, selectedCase, selectedModel, setProbePoint],
  )

  // Pin virtual sensor on click
  const handlePointerClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      if (!isProbingActive || !probePoint) return
      event.stopPropagation()
      const newSensor: VirtualSensor = {
        id: `sensor-${Date.now()}`,
        name: `Sensor ${virtualSensors.length + 1}`,
        position: probePoint.position,
        u: probePoint.u,
        v: probePoint.v,
        w: probePoint.w,
        velocity: probePoint.velocity,
        T: probePoint.T,
        tempC: probePoint.tempC,
        comfortCategory: probePoint.comfortCategory,
      }
      addVirtualSensor(newSensor)
    },
    [isProbingActive, probePoint, virtualSensors.length, addVirtualSensor],
  )

  useEffect(() => {
    return () => {
      clearTimeout(probeTimerRef.current ?? undefined)
      if (probeAbortRef.current) {
        probeAbortRef.current.abort()
      }
    }
  }, [])
  if (!details) {
    return null
  }

  return (
    <group name="airflow-scene-overlay">
      {/* Room boundary guide */}
      <lineSegments geometry={edgesGeometry} position={[4.4, 1.6, 3.05]} layers={EDITOR_LAYER}>
        <lineBasicMaterial color="#38bdf8" opacity={0.25} transparent />
      </lineSegments>

      {/* Ceiling Supply Vents (Blue diffusers with directional arrow) */}
      {details.supply_vents_xy.map(([x, y], idx) => (
        <group key={`supply-vent-${idx}`} position={[x, 3.2, y]}>
          <mesh position={[0, -0.025, 0]} layers={EDITOR_LAYER}>
            <cylinderGeometry args={[0.22, 0.22, 0.05, 16]} />
            <meshStandardMaterial color="#0284c7" />
          </mesh>
          <mesh position={[0, -0.12, 0]} layers={EDITOR_LAYER}>
            <cylinderGeometry args={[0.025, 0.025, 0.14, 8]} />
            <meshStandardMaterial color="#0284c7" />
          </mesh>
          <mesh position={[0, -0.22, 0]} rotation={[Math.PI, 0, 0]} layers={EDITOR_LAYER}>
            <coneGeometry args={[0.07, 0.1, 8]} />
            <meshStandardMaterial color="#0284c7" />
          </mesh>
        </group>
      ))}

      {/* Ceiling Return Vents (Orange grilles) */}
      {details.return_vents_xy.map(([x, y], idx) => (
        <group key={`return-vent-${idx}`} position={[x, 3.2, y]}>
          <mesh position={[0, -0.025, 0]} layers={EDITOR_LAYER}>
            <cylinderGeometry args={[0.22, 0.22, 0.05, 16]} />
            <meshStandardMaterial color="#f97316" />
          </mesh>
        </group>
      ))}

      {/* 3D Flow Slice Plane (Hardware-filtered Linear DataTexture) */}
      {sliceResult && show3DSlice && texture && (
        <mesh position={planeConfig.position} rotation={planeConfig.rotation} layers={EDITOR_LAYER}>
          <planeGeometry args={[planeConfig.size[0], planeConfig.size[1]]} />
          <meshBasicMaterial
            depthWrite={false}
            map={texture}
            opacity={sliceOpacity}
            side={THREE.DoubleSide}
            transparent
          />
        </mesh>
      )}

      {/* 3D GPU Particle Streamlines */}
      {showParticles && <ParticleStreamlines details={details} />}

      {/* Probing Interactive Raycasting Mesh */}
      {isProbingActive && (
        <mesh
          position={probePlanePosition}
          rotation={planeConfig.rotation}
          layers={EDITOR_LAYER}
          onPointerMove={handlePointerMove}
          onClick={handlePointerClick}
        >
          <planeGeometry args={[planeConfig.size[0], planeConfig.size[1]]} />
          <meshBasicMaterial transparent opacity={0.02} color="#38bdf8" side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* Active Probe Point 3D HUD Marker */}
      {isProbingActive && probePoint && (
        <group position={cfdToThree(...probePoint.position)}>
          <mesh layers={EDITOR_LAYER}>
            <sphereGeometry args={[0.06, 16, 16]} />
            <meshBasicMaterial
              color={
                probePoint.comfortCategory === 'comfort'
                  ? '#22c55e'
                  : probePoint.comfortCategory === 'draft'
                    ? '#3b82f6'
                    : '#f59e0b'
              }
            />
          </mesh>
          <mesh layers={EDITOR_LAYER}>
            <ringGeometry args={[0.08, 0.12, 16]} />
            <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} transparent opacity={0.8} />
          </mesh>
          <Html position={[0, 0.2, 0]} center distanceFactor={14}>
            <div className="pointer-events-none min-w-[210px] rounded-lg border border-slate-700 bg-slate-950/90 p-2.5 text-slate-100 shadow-xl backdrop-blur-md">
              <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 text-[11px] font-semibold">
                <span>📍 Probe Inspection</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    probePoint.comfortCategory === 'comfort'
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : probePoint.comfortCategory === 'draft'
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-amber-500/20 text-amber-400'
                  }`}
                >
                  {probePoint.comfortCategory?.toUpperCase()}
                </span>
              </div>
              <div className="mt-1.5 space-y-0.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-slate-400">Velocity |V|:</span>
                  <span className="font-mono font-medium">
                    {probePoint.velocity.toFixed(2)} m/s
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Vector (u,v,w):</span>
                  <span className="font-mono text-[10px]">
                    [{probePoint.u.toFixed(2)}, {probePoint.v.toFixed(2)}, {probePoint.w.toFixed(2)}
                    ]
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Temperature:</span>
                  <span className="font-mono font-medium">
                    {probePoint.tempC.toFixed(1)} °C ({probePoint.T.toFixed(1)} K)
                  </span>
                </div>
              </div>
              <p className="mt-1.5 text-center text-[10px] text-sky-400 italic">
                Click plane to pin sensor
              </p>
            </div>
          </Html>
        </group>
      )}

      {/* Fixed 3D Virtual Sensor Pillars */}
      {virtualSensors.map((sensor) => {
        const [threeX, threeY, threeZ] = cfdToThree(...sensor.position)
        const color =
          sensor.comfortCategory === 'comfort'
            ? '#22c55e'
            : sensor.comfortCategory === 'draft'
              ? '#3b82f6'
              : '#f59e0b'
        return (
          <group key={sensor.id} position={[threeX, 0, threeZ]}>
            <mesh position={[0, 0.02, 0]} layers={EDITOR_LAYER}>
              <cylinderGeometry args={[0.08, 0.1, 0.04, 16]} />
              <meshStandardMaterial color="#334155" />
            </mesh>
            <mesh position={[0, threeY / 2, 0]} layers={EDITOR_LAYER}>
              <cylinderGeometry args={[0.015, 0.015, threeY, 8]} />
              <meshStandardMaterial color="#64748b" />
            </mesh>
            <mesh position={[0, threeY, 0]} layers={EDITOR_LAYER}>
              <sphereGeometry args={[0.045, 16, 16]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
            </mesh>
            <Html position={[0, threeY + 0.1, 0]} center distanceFactor={15}>
              <div className="flex items-center gap-1 rounded bg-slate-900/90 px-2 py-0.5 text-[10px] text-white shadow backdrop-blur-sm border border-slate-700">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
                <span className="font-semibold">{sensor.name}:</span>
                <span>{sensor.velocity?.toFixed(2) ?? '0.00'} m/s</span>
                <button
                  type="button"
                  className="ml-1 text-slate-400 hover:text-red-400"
                  onClick={() => removeVirtualSensor(sensor.id)}
                >
                  ×
                </button>
              </div>
            </Html>
          </group>
        )
      })}
    </group>
  )
}
