import unittest

import numpy as np

from app.mesh import (
    denormalize_points,
    load_mesh,
    normalize_mesh,
    normalize_points,
    sample_interior_points,
    sample_surface_points,
)
from app.mesh_pipeline import collapse_diffusers, resolve_sampling_options
from app.schemas import DiffuserInput, MeshInferenceOptions


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


def _build_cube_obj() -> bytes:
    lines = [
        "# Simple cube",
        "v 0 0 0",
        "v 1 0 0",
        "v 1 1 0",
        "v 0 1 0",
        "v 0 0 1",
        "v 1 0 1",
        "v 1 1 1",
        "v 0 1 1",
        "f 1 2 3 4",
        "f 5 8 7 6",
        "f 1 5 6 2",
        "f 3 7 8 4",
        "f 1 4 8 5",
        "f 2 6 7 3",
    ]
    return "\n".join(lines).encode("utf-8")


def _build_flat_plane_stl() -> bytes:
    lines = [
        "solid plane",
        "  facet normal 0 0 1",
        "    outer loop",
        "      vertex 0 0 0",
        "      vertex 1 0 0",
        "      vertex 1 1 0",
        "    endloop",
        "  endfacet",
        "  facet normal 0 0 1",
        "    outer loop",
        "      vertex 0 0 0",
        "      vertex 1 1 0",
        "      vertex 0 1 0",
        "    endloop",
        "  endfacet",
        "endsolid plane",
    ]
    return "\n".join(lines).encode("utf-8")


# ---------------------------------------------------------------------------
# Mesh parsing
# ---------------------------------------------------------------------------


class MeshParsingTests(unittest.TestCase):
    def test_load_ascii_stl(self):
        mesh = load_mesh(_build_cube_stl(), "cube.stl")
        self.assertEqual(mesh.triangles.shape, (12, 3, 3))
        np.testing.assert_array_equal(mesh.bounds_min, [0, 0, 0])
        np.testing.assert_array_equal(mesh.bounds_max, [1, 1, 1])

    def test_load_obj(self):
        mesh = load_mesh(_build_cube_obj(), "cube.obj")
        self.assertGreater(mesh.triangles.shape[0], 0)
        np.testing.assert_array_equal(mesh.bounds_min, [0, 0, 0])
        np.testing.assert_array_equal(mesh.bounds_max, [1, 1, 1])

    def test_reject_empty_bytes(self):
        with self.assertRaises(ValueError):
            load_mesh(b"", "cube.stl")

    def test_reject_truncated_stl(self):
        with self.assertRaises(ValueError):
            load_mesh(b"solid cube\nendsolid cube", "cube.stl")

    def test_reject_unsupported_extension(self):
        with self.assertRaises(ValueError):
            load_mesh(b"data", "room.ply")


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


class NormalizationTests(unittest.TestCase):
    def test_normalize_mesh_centers_at_origin(self):
        mesh = load_mesh(_build_cube_stl(), "cube.stl")
        norm = normalize_mesh(mesh)
        center = norm.center
        np.testing.assert_allclose(center, [0, 0, 0], atol=1e-5)

    def test_normalize_mesh_scale_is_one(self):
        mesh = load_mesh(_build_cube_stl(), "cube.stl")
        norm = normalize_mesh(mesh)
        self.assertAlmostEqual(norm.scale, 1.0, places=5)

    def test_denormalize_inverts_normalize(self):
        mesh = load_mesh(_build_cube_stl(), "cube.stl")
        center = mesh.center
        scale = mesh.scale
        points = np.array([[0.5, 0.5, 0.5], [0.0, 0.0, 0.0]], dtype=np.float32)
        normalized = normalize_points(points, center, scale)
        restored = denormalize_points(normalized, center, scale)
        np.testing.assert_allclose(restored, points, atol=1e-5)


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------


class SamplingTests(unittest.TestCase):
    def test_surface_sample_count(self):
        mesh = load_mesh(_build_cube_stl(), "cube.stl")
        norm = normalize_mesh(mesh)
        rng = np.random.default_rng(42)
        pts = sample_surface_points(norm, 200, rng)
        self.assertEqual(pts.shape, (200, 3))

    def test_interior_samples_within_bounds(self):
        mesh = load_mesh(_build_cube_stl(), "cube.stl")
        norm = normalize_mesh(mesh)
        rng = np.random.default_rng(42)
        pts = sample_interior_points(norm, 50, rng)
        self.assertEqual(pts.shape[0], 50)
        self.assertTrue(np.all(pts >= norm.bounds_min - 1e-4))
        self.assertTrue(np.all(pts <= norm.bounds_max + 1e-4))

    def test_interior_sampling_fails_for_flat_plane(self):
        with self.assertRaises(ValueError):
            mesh = load_mesh(_build_flat_plane_stl(), "plane.stl")
            norm = normalize_mesh(mesh)
            rng = np.random.default_rng(42)
            sample_interior_points(norm, 10, rng)


# ---------------------------------------------------------------------------
# Diffuser collapsing
# ---------------------------------------------------------------------------


class DiffuserCollapsingTests(unittest.TestCase):
    def test_single_supply_and_return(self):
        diffusers = [
            DiffuserInput(id="s1", kind="supply", center=[1, 2, 3], direction=[0, -1, 0]),
            DiffuserInput(id="r1", kind="return", center=[4, 5, 6]),
        ]
        result = collapse_diffusers(diffusers)
        np.testing.assert_allclose(result.inlet_center_world, [1, 2, 3])
        np.testing.assert_allclose(result.outlet_center_world, [4, 5, 6])
        np.testing.assert_allclose(result.inlet_velocity_world, [0, -1, 0])
        self.assertEqual(result.supply_diffuser_ids, ["s1"])
        self.assertEqual(result.return_diffuser_ids, ["r1"])

    def test_multiple_supply_weighted_average(self):
        diffusers = [
            DiffuserInput(id="s1", kind="supply", center=[0, 0, 0], direction=[2, 0, 0]),
            DiffuserInput(id="s2", kind="supply", center=[2, 0, 0], direction=[2, 0, 0]),
            DiffuserInput(id="r1", kind="return", center=[1, 1, 0]),
        ]
        result = collapse_diffusers(diffusers)
        np.testing.assert_allclose(result.inlet_center_world, [1, 0, 0])

    def test_missing_direction_on_all_supply_raises(self):
        diffusers = [
            DiffuserInput(id="s1", kind="supply", center=[0, 0, 0]),
            DiffuserInput(id="r1", kind="return", center=[1, 0, 0]),
        ]
        with self.assertRaises(ValueError):
            collapse_diffusers(diffusers)

    def test_zero_direction_raises(self):
        diffusers = [
            DiffuserInput(id="s1", kind="supply", center=[0, 0, 0], direction=[0, 0, 0]),
            DiffuserInput(id="r1", kind="return", center=[1, 0, 0]),
        ]
        with self.assertRaises(ValueError):
            collapse_diffusers(diffusers)

    def test_airflow_rate_overrides_direction_magnitude(self):
        diffusers = [
            DiffuserInput(
                id="s1",
                kind="supply",
                center=[0, 0, 0],
                direction=[0, -1, 0],
                airflowRate=3.0,
            ),
            DiffuserInput(id="r1", kind="return", center=[1, 0, 0]),
        ]
        result = collapse_diffusers(diffusers)
        np.testing.assert_allclose(result.inlet_velocity_world, [0, -3, 0])

    def test_missing_supply_raises(self):
        diffusers = [
            DiffuserInput(id="r1", kind="return", center=[1, 0, 0]),
            DiffuserInput(id="r2", kind="return", center=[2, 0, 0]),
        ]
        with self.assertRaises(ValueError):
            collapse_diffusers(diffusers)

    def test_missing_return_raises(self):
        diffusers = [
            DiffuserInput(id="s1", kind="supply", center=[0, 0, 0], direction=[1, 0, 0]),
            DiffuserInput(id="s2", kind="supply", center=[1, 0, 0], direction=[1, 0, 0]),
        ]
        with self.assertRaises(ValueError):
            collapse_diffusers(diffusers)


# ---------------------------------------------------------------------------
# Quality presets
# ---------------------------------------------------------------------------


class QualityPresetTests(unittest.TestCase):
    def test_preview_preset(self):
        opts = MeshInferenceOptions(quality="preview")
        resolved = resolve_sampling_options(opts)
        self.assertEqual(resolved.quality, "preview")
        self.assertEqual(resolved.boundary_count, 1000)
        self.assertEqual(resolved.interior_count, 1000)

    def test_standard_preset(self):
        resolved = resolve_sampling_options(MeshInferenceOptions(quality="standard"))
        self.assertEqual(resolved.boundary_count, 5000)
        self.assertEqual(resolved.interior_count, 5000)

    def test_high_preset(self):
        resolved = resolve_sampling_options(MeshInferenceOptions(quality="high"))
        self.assertEqual(resolved.boundary_count, 20000)
        self.assertEqual(resolved.interior_count, 12000)

    def test_explicit_overrides_take_precedence(self):
        opts = MeshInferenceOptions(quality="preview", boundaryCount=300, interiorCount=150)
        resolved = resolve_sampling_options(opts)
        self.assertEqual(resolved.boundary_count, 300)
        self.assertEqual(resolved.interior_count, 150)

    def test_default_is_standard(self):
        resolved = resolve_sampling_options(None)
        self.assertEqual(resolved.quality, "standard")
        self.assertEqual(resolved.boundary_count, 5000)
