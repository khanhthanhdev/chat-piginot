import asyncio
import unittest
from types import SimpleNamespace

from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
import torch

from app.api import hvac_inference
from app.inference import get_inference_runtime, run_inference
from app.errors import request_validation_exception_handler
from app.schemas import GinotInferenceRequest
from app.settings import get_settings


class InferenceRouteTests(unittest.TestCase):
    def setUp(self):
        get_settings.cache_clear()
        get_inference_runtime.cache_clear()

    def test_hvac_inference_returns_valid_response(self):
        request = GinotInferenceRequest(
            load=[0.0, 0.0, 0.5, 0.0, 0.0, -0.5, 0.0, -1.0, 0.0],
            pc=[0.0] * 300,
            xyt=[0.0] * 30,
            metadata={
                "boundaryCount": 100,
                "interiorCount": 10,
                "center": [5.0, 1.4, 5.0],
                "scale": 10.0,
            },
        )
        response = asyncio.run(hvac_inference(request))
        payload = response.model_dump()

        self.assertEqual(len(payload["positions"]), 10)
        self.assertEqual(len(payload["velocities"]), 10)
        self.assertEqual(len(payload["pressure"]), 10)
        self.assertEqual(len(payload["speed"]), 10)
        self.assertAlmostEqual(payload["positions"][0][0], 5.0, places=5)
        self.assertAlmostEqual(payload["positions"][0][1], 1.4, places=5)
        self.assertAlmostEqual(payload["positions"][0][2], 5.0, places=5)
        self.assertEqual(payload["metadata"]["inletVelocity"], [0.0, -1.0, 0.0])
        self.assertIn("inferenceId", payload)
        self.assertGreaterEqual(payload["computeTimeMs"], 0.0)

    def test_hvac_inference_returns_400_for_invalid_body(self):
        with self.assertRaises(ValidationError) as ctx:
            GinotInferenceRequest(
                load=[0.0] * 8,
                pc=[0.0] * 300,
                xyt=[0.0] * 3,
            )

        error = RequestValidationError(ctx.exception.errors())
        response = asyncio.run(request_validation_exception_handler(None, error))

        self.assertEqual(response.status_code, 400)
        self.assertIn("load", response.body.decode())

    def test_onnx_inference_uses_current_response_contract(self):
        class FakeOnnxSession:
            def get_inputs(self):
                return [
                    SimpleNamespace(name="load"),
                    SimpleNamespace(name="xyt"),
                    SimpleNamespace(name="pc"),
                ]

            def run(self, _outputs, feed):
                batch_size, point_count, _ = feed["xyt"].shape
                return [torch.ones(batch_size, point_count, 4).numpy()]

        xyt = torch.zeros(1, 3, 3)
        prediction = run_inference(
            load=torch.zeros(1, 9),
            pc=torch.zeros(1, 100, 3),
            xyt=xyt,
            model=FakeOnnxSession(),
            device="cpu",
            engine="onnx",
        )

        self.assertEqual(tuple(prediction.velocities.shape), (3, 3))
        self.assertEqual(tuple(prediction.pressure.shape), (3,))
        self.assertTrue((prediction.speed > 0).all())
