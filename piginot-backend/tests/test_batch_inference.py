import base64
import unittest

import numpy as np
from fastapi.testclient import TestClient

from app.main import app


def candidate(spacing: float) -> dict:
    terminals = []
    for role, y, direction in (
        ("supply", 1.0, [0, 0, -1]),
        ("return", 3.0, [0, 0, 1]),
    ):
        for index, x in enumerate((2.0 - spacing, 2.0, 2.0 + spacing)):
            terminals.append(
                {
                    "id": f"{role}-{index}",
                    "role": role,
                    "centre": [x, y, 3.0],
                    "direction": direction,
                    "faceVelocity": 1.0,
                }
            )
    return {"id": f"candidate-{spacing}", "terminals": terminals}


class BatchInferenceTests(unittest.TestCase):
    def test_rest_contract_preserves_all_terminals_and_spacing_changes_prediction(self):
        payload = {
            "room": {"id": "room-1", "minimum": [0, 0, 0], "maximum": [4, 4, 3]},
            "grid": {"shape": [4, 4, 2], "origin": [0.5, 0.5, 0.75], "spacing": [1, 1, 1.5]},
            "candidates": [candidate(0.5), candidate(1.0)],
        }
        with TestClient(app) as client:
            response = client.post("/api/v1/hvac-inference-batch", json=payload)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["model"]["id"], "piginot-six-terminal")
        self.assertEqual(len(body["candidates"]), 2)
        fields = [
            np.frombuffer(base64.b64decode(result["velocityMagnitudeBase64"]), dtype="<f4")
            for result in body["candidates"]
        ]
        self.assertEqual(fields[0].shape, (32,))
        self.assertFalse(np.array_equal(fields[0], fields[1]))

    def test_rejects_more_than_25_candidates(self):
        payload = {
            "room": {"id": "room-1", "minimum": [0, 0, 0], "maximum": [4, 4, 3]},
            "grid": {"shape": [1, 1, 1], "origin": [1, 1, 1], "spacing": [1, 1, 1]},
            "candidates": [candidate(0.1 + index / 100) for index in range(26)],
        }
        with TestClient(app) as client:
            response = client.post("/api/v1/hvac-inference-batch", json=payload)
        self.assertEqual(response.status_code, 400)
