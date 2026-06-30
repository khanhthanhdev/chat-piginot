import asyncio
import json
import unittest

import numpy as np
from fastapi import HTTPException
from starlette.requests import Request


from app.api_mesh import hvac_inference_from_mesh
from app.inference import get_inference_runtime
from app.mesh import load_mesh, normalize_mesh, sample_interior_points, sample_surface_points
from app.mesh_pipeline import preprocess_mesh_inference
from app.models.ginot import PhysicsNormalization
from app.schemas import MeshInferenceRequest
from app.settings import get_settings


def _build_cube_stl() -> bytes:
    triangles = [
        ((0, 0, 0), (1, 0, 0), (1, 1, 0)),
        ((0, 0, 0), (1, 1, 0), (0, 1, 0)),
        ((0, 0, 1), (1, 1, 1), (1, 0, 1)),
        ((0, 0, 1), (0, 1, 1), (1, 1, 1)),
        ((0, 0, 0), (0, 0, 1), (1, 0, 1)),
        ((0, 0, 0), (1, 0, 1), (1, 0, 0)),
        ((0, 1, 0), (1, 1, 1), (0, 1, 1)),
        ((0, 1, 0), (1, 1, 0), (1, 1, 1)),
        ((0, 0, 0), (0, 1, 1), (0, 0, 1)),
        ((0, 0, 0), (0, 1, 0), (0, 1, 1)),
        ((1, 0, 0), (1, 0, 1), (1, 1, 1)),
        ((1, 0, 0), (1, 1, 1), (1, 1, 0)),
    ]

    lines = ["solid cube"]
    for a, b, c in triangles:
        lines.append("  facet normal 0 0 0")
        lines.append("    outer loop")
        lines.append(f"      vertex {a[0]} {a[1]} {a[2]}")
        lines.append(f"      vertex {b[0]} {b[1]} {b[2]}")
        lines.append(f"      vertex {c[0]} {c[1]} {c[2]}")
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append("endsolid cube")
    return "\n".join(lines).encode("utf-8")


def _build_multipart_request(
    *,
    fields: dict[str, str],
    files: dict[str, tuple[str, str, bytes]],
    boundary: str = "test-boundary",
) -> Request:
    body_parts = []

    for name, value in fields.items():
        body_parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode("utf-8")
        )

    for name, (filename, content_type, content) in files.items():
        body_parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
            + content
            + b"\r\n"
        )

    body_parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(body_parts)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/hvac-inference-mesh",
        "headers": [
            (b"content-type", f"multipart/form-data; boundary={boundary}".encode()),
            (b"content-length", str(len(body)).encode()),
        ],
        "state": {"request_id": "test"},
    }

    async def receive():
        return {"type": "http.request", "body": body}

    return Request(scope, receive)


class MeshUtilityTests(unittest.TestCase):
    def test_mesh_pipeline_loads_normalizes_and_samples(self):
        mesh = load_mesh(_build_cube_stl(), "cube.stl")
        mesh_norm = normalize_mesh(mesh)
        rng = np.random.default_rng(0)

        boundary = sample_surface_points(mesh_norm, 100, rng)
        interior = sample_interior_points(mesh_norm, 25, rng)

        self.assertEqual(tuple(boundary.shape), (100, 3))
        self.assertEqual(tuple(interior.shape), (25, 3))
        self.assertTrue(np.all(boundary >= -0.5 - 1e-4))
        self.assertTrue(np.all(boundary <= 0.5 + 1e-4))
        self.assertTrue(np.all(interior >= -0.5 - 1e-4))
        self.assertTrue(np.all(interior <= 0.5 + 1e-4))

    def test_preprocess_mesh_inference_derives_load_from_world_diffusers(self):
        request = MeshInferenceRequest.model_validate(
            {
                "diffusers": [
                    {
                        "id": "supply-1",
                        "kind": "supply",
                        "center": [0.5, 0.5, 0.5],
                        "direction": [2.0, 0.0, 0.0],
                        "width": 0.4,
                        "depth": 0.2,
                        "mount": "wall",
                        "rotation": np.pi / 2,
                    },
                    {
                        "id": "return-1",
                        "kind": "return",
                        "center": [0.75, 0.75, 0.75],
                        "width": 0.2,
                        "depth": 0.2,
                        "mount": "ceiling",
                    },
                ],
                "options": {
                    "quality": "preview",
                    "boundaryCount": 100,
                    "interiorCount": 12,
                },
            }
        )

        preprocessed = preprocess_mesh_inference(
            request,
            mesh_bytes=_build_cube_stl(),
            filename="cube.stl",
            rng=np.random.default_rng(0),
        )

        load = preprocessed.load.squeeze(0).cpu().numpy()

        self.assertTrue(np.allclose(load[:3], [0.0, 0.0, 0.0]))
        self.assertTrue(np.allclose(load[3:6], [0.25, 0.25, 0.25]))
        self.assertTrue(np.allclose(load[6:], [2.0, 0.0, 0.0]))
        self.assertEqual(preprocessed.sampling.quality, "preview")
        self.assertEqual(preprocessed.sampling.boundary_count, 100)
        self.assertEqual(preprocessed.sampling.interior_count, 12)

    def test_preprocess_mesh_inference_builds_physics_boundary_features(self):
        request = MeshInferenceRequest.model_validate(
            {
                "diffusers": [
                    {
                        "id": "supply-1",
                        "kind": "supply",
                        "center": [0.5, 0.5, 0.5],
                        "direction": [2.0, 0.0, 0.0],
                        "width": 0.4,
                        "depth": 0.2,
                        "mount": "wall",
                        "rotation": np.pi / 2,
                    },
                    {
                        "id": "return-1",
                        "kind": "return",
                        "center": [0.75, 0.75, 0.75],
                        "width": 0.2,
                        "depth": 0.2,
                        "mount": "ceiling",
                    },
                ],
                "options": {"quality": "preview", "boundaryCount": 100, "interiorCount": 12},
            }
        )
        normalization = PhysicsNormalization(
            coord_min=(0.0, 0.0, 0.0),
            coord_scale=(2.0, 2.0, 2.0),
            target_mean=(1.0, 2.0, 3.0, 4.0),
            target_std=(2.0, 2.0, 2.0, 2.0),
        )

        preprocessed = preprocess_mesh_inference(
            request,
            mesh_bytes=_build_cube_stl(),
            filename="cube.stl",
            rng=np.random.default_rng(0),
            normalization=normalization,
        )
        pc = preprocessed.pc.squeeze(0).numpy()

        self.assertEqual(pc.shape, (100, 12))
        wall = pc[pc[:, 4] == 1]
        inlet = pc[pc[:, 5] == 1]
        outlet = pc[pc[:, 6] == 1]
        inlet_world = inlet[:, :3] * 2
        self.assertGreater(len(inlet), 1)
        self.assertTrue(np.allclose(inlet_world[:, 0], 0.5))
        self.assertGreater(np.ptp(inlet_world[:, 1]), 0.1)
        self.assertGreater(np.ptp(inlet_world[:, 2]), 0.3)
        self.assertTrue(np.allclose(wall[:, 8:], [-0.5, -1.0, -1.5, 0.0]))
        self.assertTrue(np.allclose(inlet[:, 8:], [0.5, -1.0, -1.5, 0.0]))
        self.assertTrue(np.allclose(outlet[:, 8:], [0.0, 0.0, 0.0, -2.0]))
        self.assertTrue(np.all(preprocessed.xyt.numpy() >= 0.0))
        self.assertTrue(np.all(preprocessed.xyt.numpy() <= 0.5))

    def test_grid_sampling_is_deterministic_and_row_major(self):
        request = MeshInferenceRequest.model_validate(
            {
                "diffusers": [
                    {"id": "s", "kind": "supply", "center": [0, 0, 0], "direction": [1, 0, 0]},
                    {"id": "r", "kind": "return", "center": [1, 1, 1]},
                ],
                "options": {"quality": "preview", "interiorCount": 64, "returnGrid3D": True},
            }
        )
        first = preprocess_mesh_inference(
            request, mesh_bytes=_build_cube_stl(), filename="cube.stl", rng=np.random.default_rng(1)
        )
        second = preprocess_mesh_inference(
            request, mesh_bytes=_build_cube_stl(), filename="cube.stl", rng=np.random.default_rng(2)
        )

        self.assertEqual(first.grid, second.grid)
        self.assertTrue(np.array_equal(first.positions_world, second.positions_world))
        self.assertEqual(first.grid["indices"], sorted(first.grid["indices"]))
        self.assertEqual(len(first.grid["indices"]), len(first.positions_world))

    def test_grid_dimensions_stay_at_least_two(self):
        request = MeshInferenceRequest.model_validate(
            {
                "diffusers": [
                    {"id": "s", "kind": "supply", "center": [0, 0, 0], "direction": [1, 0, 0]},
                    {"id": "r", "kind": "return", "center": [1, 1, 1]},
                ],
                "options": {"quality": "preview", "interiorCount": 1, "returnGrid3D": True},
            }
        )
        preprocessed = preprocess_mesh_inference(
            request, mesh_bytes=_build_cube_stl(), filename="cube.stl", rng=np.random.default_rng(0)
        )

        self.assertTrue(all(dim >= 2 for dim in preprocessed.grid["dimensions"]))


class MeshInferenceRouteTests(unittest.TestCase):
    def setUp(self):
        get_settings.cache_clear()
        get_inference_runtime.cache_clear()

    def test_mesh_inference_returns_world_coordinates(self):
        mesh_bytes = _build_cube_stl()
        request = _build_multipart_request(
            fields={
                "diffusers": json.dumps(
                    [
                        {
                            "id": "supply-1",
                            "kind": "supply",
                            "center": [0.5, 0.5, 0.5],
                            "direction": [1.5, 0.0, 0.0],
                        },
                        {
                            "id": "return-1",
                            "kind": "return",
                            "center": [0.75, 0.75, 0.75],
                        },
                    ]
                ),
                "options": json.dumps(
                    {
                        "quality": "preview",
                        "boundaryCount": 100,
                        "interiorCount": 12,
                    }
                ),
            },
            files={"meshFile": ("cube.stl", "model/stl", mesh_bytes)},
        )

        response = asyncio.run(hvac_inference_from_mesh(request))
        payload = response.model_dump()

        self.assertEqual(len(payload["positions"]), 12)
        self.assertEqual(len(payload["velocities"]), 12)
        self.assertEqual(payload["bounds"]["min"], [0.0, 0.0, 0.0])
        self.assertEqual(payload["bounds"]["max"], [1.0, 1.0, 1.0])
        self.assertEqual(payload["metadata"]["inletCenter"], [0.5, 0.5, 0.5])
        self.assertEqual(payload["metadata"]["outletCenter"], [0.75, 0.75, 0.75])
        self.assertEqual(payload["metadata"]["inletVelocity"], [1.5, 0.0, 0.0])
        self.assertEqual(payload["metadata"]["boundaryCount"], 100)
        self.assertEqual(payload["metadata"]["interiorCount"], 12)
        self.assertEqual(payload["metadata"]["quality"], "preview")
        self.assertEqual(payload["metadata"]["supplyDiffuserIds"], ["supply-1"])
        self.assertEqual(payload["metadata"]["returnDiffuserIds"], ["return-1"])
        for position in payload["positions"]:
            self.assertGreaterEqual(min(position), 0.0)
            self.assertLessEqual(max(position), 1.0)

    def test_mesh_inference_rejects_unsupported_file(self):
        request = _build_multipart_request(
            fields={
                "diffusers": json.dumps(
                    [
                        {
                            "id": "supply-1",
                            "kind": "supply",
                            "center": [0.5, 0.5, 0.5],
                            "direction": [1.0, 0.0, 0.0],
                        },
                        {
                            "id": "return-1",
                            "kind": "return",
                            "center": [0.75, 0.75, 0.75],
                        },
                    ]
                ),
                "options": json.dumps({"boundaryCount": 100, "interiorCount": 5}),
            },
            files={"meshFile": ("cube.txt", "text/plain", b"not-a-mesh")},
        )

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(hvac_inference_from_mesh(request))

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Unsupported mesh file", ctx.exception.detail)

    def test_mesh_inference_rejects_missing_return_diffuser(self):
        request = _build_multipart_request(
            fields={
                "diffusers": json.dumps(
                    [
                        {
                            "id": "supply-1",
                            "kind": "supply",
                            "center": [0.5, 0.5, 0.5],
                            "direction": [1.0, 0.0, 0.0],
                        },
                        {
                            "id": "supply-2",
                            "kind": "supply",
                            "center": [0.4, 0.5, 0.5],
                            "direction": [0.5, 0.0, 0.0],
                        }
                    ]
                ),
                "options": json.dumps({"boundaryCount": 100, "interiorCount": 5}),
            },
            files={"meshFile": ("cube.stl", "model/stl", _build_cube_stl())},
        )

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(hvac_inference_from_mesh(request))

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("return diffuser", ctx.exception.detail)
