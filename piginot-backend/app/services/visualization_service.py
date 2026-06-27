from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np
import plotly.graph_objects as go

LOGGER = logging.getLogger(__name__)


def generate_pressure_velocity_visualization(
    *,
    positions: np.ndarray,
    velocities: np.ndarray,
    pressure: np.ndarray,
    speed: np.ndarray,
    output_dir: str = "data/visualizations",
    inference_id: str,
) -> str:
    """
    Generate 3D interactive visualization from CFD inference results.

    Creates a 3D point cloud showing velocity magnitude distribution with
    interactive Plotly visualization.

    Args:
        positions: (N, 3) array of query point positions
        velocities: (N, 3) array of velocity vectors
        pressure: (N,) array of pressure values
        speed: (N,) array of velocity magnitudes
        output_dir: Directory to save visualization files
        inference_id: Unique identifier for this inference run

    Returns:
        Path to the saved HTML file
    """
    positions = np.asarray(positions)
    velocities = np.asarray(velocities)
    pressure = np.asarray(pressure)
    speed = np.asarray(speed)

    output_path = Path(output_dir).resolve()
    output_path.mkdir(parents=True, exist_ok=True)

    timestamp = int(time.time() * 1000)
    html_filename = f"{inference_id}_{timestamp}.html"
    html_path = output_path / html_filename

    # Create 3D scatter plot colored by velocity magnitude
    fig = go.Figure(
        data=[
            go.Scatter3d(
                x=positions[:, 0],
                y=positions[:, 1],
                z=positions[:, 2],
                mode="markers",
                marker=dict(
                    size=3,
                    color=speed,
                    colorscale="Jet",
                    opacity=0.6,
                    colorbar=dict(title="Velocity Magnitude (m/s)"),
                ),
                text=[f"Speed: {s:.2f} m/s" for s in speed],
                hoverinfo="text",
            )
        ]
    )

    fig.update_layout(
        title="3D Indoor Airflow Prediction",
        scene=dict(
            xaxis_title="X (m)",
            yaxis_title="Y (m)",
            zaxis_title="Z (m)",
            aspectmode="data",
        ),
        margin=dict(l=0, r=0, b=0, t=40),
    )

    fig.write_html(str(html_path))

    relative_path = str(html_path.relative_to(Path.cwd()))
    LOGGER.info(
        "inference_id=%s visualization saved to %s",
        inference_id,
        relative_path,
    )

    return relative_path
