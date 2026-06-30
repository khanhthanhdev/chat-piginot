import base64
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import torch
from fastapi.testclient import TestClient
from fastmcp import Client

from app.main import app, mcp
from app.models.ginot import PhysicsNormalization


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
                    "width": 0.4,
                    "depth": 0.2,
                    "rotation": 0.0,
                }
            )
    return {"id": f"candidate-{spacing}", "terminals": terminals}


class BatchInferenceTests(unittest.TestCase):
    def test_checkpoint_model_handles_the_six_terminal_batch_contract(self):
        class PhysicsFixture(torch.nn.Module):
            normalization = PhysicsNormalization(
                coord_min=(0.0, 0.0, 0.0),
                coord_scale=(4.0, 4.0, 3.0),
                target_mean=(0.0, 0.0, 0.0, 0.0),
                target_std=(1.0, 1.0, 1.0, 1.0),
            )

            def forward(self, load, xyt, pc):
                self.pc = pc
                return torch.ones((xyt.shape[0], xyt.shape[1], 4), device=xyt.device)

        model = PhysicsFixture()
        runtime = SimpleNamespace(
            model=model,
            engine="torch",
            device="cpu",
            source="/models/new-physics.pth",
            checkpoint_path="/models/new-physics.pth",
            normalization=model.normalization,
        )
        payload = {
            "room": {"id": "room-1", "minimum": [0, 0, 0], "maximum": [4, 4, 3]},
            "grid": {"shape": [2, 2, 1], "origin": [1, 1, 1], "spacing": [1, 1, 1]},
            "candidates": [candidate(0.5)],
        }

        with (
            patch(
                "app.services.batch_inference_service.get_inference_runtime",
                return_value=runtime,
            ),
            TestClient(app) as client,
        ):
            response = client.post("/api/v1/hvac-inference-batch", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["model"], {
            "id": "new-physics",
            "version": "1",
            "source": "checkpoint",
        })
        self.assertEqual(tuple(model.pc.shape), (1, 4096, 12))
        self.assertGreater(int((model.pc[0, :, 5] == 1).sum()), 3)
        self.assertGreater(int((model.pc[0, :, 6] == 1).sum()), 3)

    def test_rest_contract_preserves_all_terminals_and_spacing_changes_prediction(self):
        payload = {
            "room": {"id": "room-1", "minimum": [0, 0, 0], "maximum": [4, 4, 3]},
            "grid": {"shape": [4, 4, 2], "origin": [0.5, 0.5, 0.75], "spacing": [1, 1, 1.5]},
            "candidates": [candidate(0.5), candidate(1.0)],
        }
        with (
            patch.dict(os.environ, {"PIGINOT_ALLOW_SYNTHETIC": "true"}),
            TestClient(app) as client,
        ):
            response = client.post("/api/v1/hvac-inference-batch", json=payload)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["model"]["id"], "piginot-analytic-six-terminal")
        self.assertEqual(body["model"]["source"], "analytic-test-fixture")
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
        with (
            patch.dict(os.environ, {"PIGINOT_ALLOW_SYNTHETIC": "true"}),
            TestClient(app) as client,
        ):
            response = client.post("/api/v1/hvac-inference-batch", json=payload)
        self.assertEqual(response.status_code, 400)

    def test_fails_closed_without_explicit_synthetic_opt_in(self):
        payload = {
            "room": {"id": "room-1", "minimum": [0, 0, 0], "maximum": [4, 4, 3]},
            "grid": {"shape": [1, 1, 1], "origin": [1, 1, 1], "spacing": [1, 1, 1]},
            "candidates": [candidate(0.5)],
        }
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PIGINOT_ALLOW_SYNTHETIC", None)
            with TestClient(app) as client:
                response = client.post("/api/v1/hvac-inference-batch", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("disabled", response.json()["detail"])

    def test_fastmcp_client_uses_the_same_six_terminal_contract(self):
        async def call_batch():
            async with Client(mcp) as client:
                tools = await client.list_tools()
                tool = next(
                    item for item in tools if "hvac_inference_batch" in item.name
                )
                return await client.call_tool(
                    tool.name,
                    {
                        "room": {
                            "id": "room-1",
                            "minimum": [0, 0, 0],
                            "maximum": [4, 4, 3],
                        },
                        "grid": {
                            "shape": [2, 2, 1],
                            "origin": [0.5, 0.5, 1],
                            "spacing": [1, 1, 1],
                        },
                        "candidates": [candidate(0.5)],
                    },
                )

        import asyncio

        with patch.dict(os.environ, {"PIGINOT_ALLOW_SYNTHETIC": "true"}):
            result = asyncio.run(call_batch())
        self.assertFalse(result.is_error)
        self.assertEqual(result.data.candidates[0].status, "succeeded")
