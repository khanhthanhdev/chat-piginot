import { type CameraPose, emitter } from '@pascal-app/core'
import { type ComfortMetric, type SliceAxis, useAirflowStore } from './airflow-store'

export type ZoneName = 'west_desks' | 'east_desks' | 'meeting_table' | 'perimeter' | 'center'

export const ZONE_CAMERA_POSES: Record<ZoneName, CameraPose> = {
  west_desks: {
    position: [2.0, 4.0, 7.5],
    target: [2.0, 1.1, 3.0],
    projection: 'perspective',
  },
  east_desks: {
    position: [7.0, 4.0, 7.5],
    target: [7.0, 1.1, 3.0],
    projection: 'perspective',
  },
  meeting_table: {
    position: [4.4, 4.2, 6.8],
    target: [4.4, 1.1, 3.0],
    projection: 'perspective',
  },
  perimeter: {
    position: [4.4, 7.5, 9.5],
    target: [4.4, 1.6, 3.05],
    projection: 'perspective',
  },
  center: {
    position: [4.4, 4.5, 6.5],
    target: [4.4, 1.1, 3.05],
    projection: 'perspective',
  },
}

export function focusZoneCamera(zone: ZoneName): void {
  const pose = ZONE_CAMERA_POSES[zone]
  if (pose) {
    emitter.emit('camera-controls:apply-pose', pose)
  }
}

export function applyAirflowVisualization(config: {
  sliceAxis?: SliceAxis
  sliceValue?: number
  metric?: ComfortMetric
  show3DSlice?: boolean
  showParticles?: boolean
}): void {
  const store = useAirflowStore.getState()
  if (config.sliceAxis !== undefined) store.setSliceAxis(config.sliceAxis)
  if (config.sliceValue !== undefined) store.setSliceValue(config.sliceValue)
  if (config.metric !== undefined) store.setMetric(config.metric)
  if (config.show3DSlice !== undefined) store.setShow3DSlice(config.show3DSlice)
  if (config.showParticles !== undefined) store.setShowParticles(config.showParticles)
}
