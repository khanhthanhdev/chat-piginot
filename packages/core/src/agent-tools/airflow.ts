import { z } from 'zod'

export const queryAirflowPointTool = {
  name: 'query_airflow_point',
  title: 'Query airflow point',
  description:
    'Query predicted indoor airflow velocity vector (u, v, w in m/s), speed magnitude, and air temperature (K / °C) at a specific 3D point in the room using the LGO neural operator surrogate model.',
  input: {
    case: z.string().describe('Precomputed CFD case identifier (e.g. "B001", "D006").'),
    run: z
      .string()
      .optional()
      .describe('Neural operator model run identifier (default: recommended LGO-GINOT model).'),
    point: z
      .array(z.number())
      .length(3)
      .describe(
        'CFD coordinates [x, y, z] in metres within room bounds [0, 8.8] x [0, 6.1] x [0, 3.2].',
      ),
  },
}

export const inspectZoneComfortTool = {
  name: 'inspect_zone_comfort',
  title: 'Inspect zone comfort',
  description:
    'Evaluate ASHRAE 55 thermal comfort compliance, mean air speed, mean temperature, and draft rate (DR) for a named room occupant zone (west_desks, east_desks, meeting_table, perimeter, or center) at standard height.',
  input: {
    case: z.string().describe('Precomputed CFD case identifier (e.g. "B001").'),
    run: z.string().optional().describe('Neural operator model run identifier.'),
    zone: z
      .enum(['west_desks', 'east_desks', 'meeting_table', 'perimeter', 'center'])
      .describe('Target occupancy zone to inspect.'),
    height: z
      .number()
      .default(1.1)
      .describe(
        'Evaluation plane height in metres (standard seated height: 1.1m, standing: 1.7m).',
      ),
  },
}

export const setAirflowVisualizationTool = {
  name: 'set_airflow_visualization',
  title: 'Set airflow visualization',
  description:
    'Configure the 3D editor airflow visualization state: slice plane axis (X, Y, Z), plane position, comfort/speed metric, 3D slice plane visibility, or particle streamlines.',
  input: {
    sliceAxis: z
      .enum(['x', 'y', 'z'])
      .optional()
      .describe(
        'Slice plane axis: "z" (horizontal floor plane), "x" (cross-room), or "y" (longitudinal).',
      ),
    sliceValue: z
      .number()
      .optional()
      .describe('Slice plane position in metres along the active axis.'),
    metric: z
      .enum(['speed', 'temperature', 'comfort'])
      .optional()
      .describe(
        'Display metric: "speed" (Turbo colormap), "temperature" (Cool-to-warm), or "comfort" (ASHRAE 55 3-zone map).',
      ),
    show3DSlice: z
      .boolean()
      .optional()
      .describe('Whether the 3D slice plane mesh is visible in the viewport.'),
    showParticles: z
      .boolean()
      .optional()
      .describe('Whether 3D GPU streamline particles are visible and advecting.'),
  },
}
