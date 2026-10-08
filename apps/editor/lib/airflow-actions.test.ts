import { describe, expect, it } from 'bun:test'
import { emitter } from '@pascal-app/core'
import { applyAirflowVisualization, focusZoneCamera, ZONE_CAMERA_POSES } from './airflow-actions'
import { useAirflowStore } from './airflow-store'

describe('Airflow Actions & Copilot camera bridge', () => {
  it('applies airflow visualization updates to store', () => {
    applyAirflowVisualization({
      sliceAxis: 'y',
      sliceValue: 2.8,
      metric: 'comfort',
      show3DSlice: true,
      showParticles: true,
    })

    const state = useAirflowStore.getState()
    expect(state.sliceAxis).toBe('y')
    expect(state.sliceValue).toBe(2.8)
    expect(state.metric).toBe('comfort')
    expect(state.show3DSlice).toBe(true)
    expect(state.showParticles).toBe(true)
  })

  it('emits camera navigation events when focusing on zones', () => {
    let emittedPose: unknown = null
    const handler = (pose: unknown) => {
      emittedPose = pose
    }

    emitter.on('camera-controls:apply-pose', handler)
    try {
      focusZoneCamera('west_desks')
      expect(emittedPose).toEqual(ZONE_CAMERA_POSES.west_desks)

      focusZoneCamera('meeting_table')
      expect(emittedPose).toEqual(ZONE_CAMERA_POSES.meeting_table)
    } finally {
      emitter.off('camera-controls:apply-pose', handler)
    }
  })
})
