import unittest

from app.schemas import GinotInferenceRequest, MeshInferenceRequest, MetadataInput
from app.validators import reshape_tensors, validate_mesh_request, validate_request


class ValidatorTests(unittest.TestCase):
    def test_validate_request_accepts_flattened_inputs(self):
        request = GinotInferenceRequest.model_construct(
            load=[0.0] * 9,
            pc=[0.0] * 300,
            xyt=[0.0] * 3,
            metadata=None,
        )

        result = validate_request(request)

        self.assertEqual(result.boundary_count, 100)
        self.assertEqual(result.interior_count, 1)

    def test_reshape_tensors_returns_model_ready_shapes(self):
        request = GinotInferenceRequest.model_construct(
            load=[0.0] * 9,
            pc=[0.0] * 300,
            xyt=[0.0] * 9,
            metadata=None,
        )

        load, pc, xyt = reshape_tensors(request)

        self.assertEqual(tuple(load.shape), (1, 9))
        self.assertEqual(tuple(pc.shape), (1, 100, 3))
        self.assertEqual(tuple(xyt.shape), (1, 3, 3))

    def test_validate_request_rejects_wrong_load_length(self):
        request = GinotInferenceRequest.model_construct(
            load=[0.0] * 8,
            pc=[0.0] * 300,
            xyt=[0.0] * 3,
            metadata=None,
        )

        with self.assertRaisesRegex(ValueError, "9 elements"):
            validate_request(request)

    def test_validate_request_rejects_metadata_count_mismatch(self):
        request = GinotInferenceRequest.model_construct(
            load=[0.0] * 9,
            pc=[0.0] * 300,
            xyt=[0.0] * 3,
            metadata=MetadataInput.model_construct(boundaryCount=500, interiorCount=1),
        )

        with self.assertRaisesRegex(ValueError, "metadata.boundaryCount"):
            validate_request(request)

    def test_validate_mesh_request_rejects_unsupported_extension(self):
        request = MeshInferenceRequest.model_validate(
            {
                "diffusers": [
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
                ],
                "options": {"boundaryCount": 100, "interiorCount": 1},
            }
        )

        with self.assertRaisesRegex(ValueError, "Unsupported mesh file"):
            validate_mesh_request(request, filename="room.txt")

    def test_validate_mesh_request_requires_supply_and_return_diffusers(self):
        request = MeshInferenceRequest.model_validate(
            {
                "diffusers": [
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
                ],
                "options": {"boundaryCount": 100, "interiorCount": 1},
            }
        )

        with self.assertRaisesRegex(ValueError, "return diffuser"):
            validate_mesh_request(request, filename="room.stl")

    def test_validate_mesh_request_rejects_duplicate_diffuser_ids(self):
        request = MeshInferenceRequest.model_validate(
            {
                "diffusers": [
                    {
                        "id": "diffuser-1",
                        "kind": "supply",
                        "center": [0.5, 0.5, 0.5],
                        "direction": [1.0, 0.0, 0.0],
                    },
                    {
                        "id": "diffuser-1",
                        "kind": "return",
                        "center": [0.75, 0.75, 0.75],
                    },
                ],
                "options": {"boundaryCount": 100, "interiorCount": 1},
            }
        )

        with self.assertRaisesRegex(ValueError, "Duplicate diffuser id"):
            validate_mesh_request(request, filename="room.stl")
