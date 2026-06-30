from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from .schemas import GinotInferenceRequest, GinotInferenceResponse
from .services.common import InferenceTimeoutError
from .services.inference_service import execute_legacy_inference
from .services.execution import run_inference_in_worker


LOGGER = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["ginot"])


@router.post(
    "/hvac-inference",
    response_model=GinotInferenceResponse,
    summary="HVAC CFD Inference",
    description="Perform CFD inference on HVAC system using pre-sampled boundary and interior query points. "
    "The request provides a point cloud and query coordinates in a normalized space, along with load vectors.",
    responses={
        200: {"description": "Successful inference result with CFD predictions"},
        400: {"description": "Invalid request parameters (insufficient points, invalid metadata)"},
        504: {"description": "Inference exceeded configured timeout"},
        500: {"description": "Internal server error during inference"},
    },
)
async def hvac_inference(request: GinotInferenceRequest) -> GinotInferenceResponse:
    try:
        return await run_inference_in_worker(lambda: execute_legacy_inference(request))
    except InferenceTimeoutError as exc:
        LOGGER.warning("inference_flow=legacy error=%s", exc)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        LOGGER.warning("inference_flow=legacy error=%s", exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        LOGGER.warning("inference_flow=legacy error=%s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Inference failed: {exc}",
        ) from exc
