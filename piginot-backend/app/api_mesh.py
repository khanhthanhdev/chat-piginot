from __future__ import annotations

import logging

from pydantic import ValidationError
from fastapi import APIRouter, HTTPException, Request, status

from .errors import format_validation_error
from .http.mesh_form import parse_mesh_form_request
from .schemas import GinotInferenceResponse
from .services.common import InferenceTimeoutError
from .services.mesh_inference_service import execute_mesh_inference
from .services.execution import run_inference_in_worker


LOGGER = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["ginot-mesh"])


@router.post(
    "/hvac-inference-mesh",
    response_model=GinotInferenceResponse,
    summary="HVAC Mesh-Based CFD Inference",
    description="Perform CFD inference directly from a mesh file (STL/OBJ). "
    "The endpoint handles mesh preprocessing, point sampling, and diffuser placement. "
    "Submit as multipart/form-data with 'meshFile', 'diffusers' (JSON), and optional 'options' and 'context'.",
    responses={
        200: {"description": "Successful mesh inference result"},
        400: {"description": "Invalid mesh, diffuser configuration, or form data"},
        504: {"description": "Mesh processing or inference exceeded timeout"},
        500: {"description": "Internal error during mesh processing or inference"},
    },
)
async def hvac_inference_from_mesh(request: Request) -> GinotInferenceResponse:
    request_id = getattr(request.state, "request_id", "unknown")

    try:
        mesh_request, mesh_file = await parse_mesh_form_request(request)
        return await run_inference_in_worker(
            lambda: execute_mesh_inference(
                mesh_request,
                mesh_file,
                request_id=request_id,
            )
        )
    except InferenceTimeoutError as exc:
        LOGGER.warning("request_id=%s error=%s", request_id, exc)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=str(exc),
        ) from exc
    except ValidationError as exc:
        detail = format_validation_error(exc, fallback_message="Invalid mesh inference request")
        LOGGER.warning("request_id=%s error=%s", request_id, detail)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail) from exc
    except ValueError as exc:
        LOGGER.warning("request_id=%s error=%s", request_id, exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        LOGGER.warning("request_id=%s error=%s", request_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Mesh inference failed: {exc}",
        ) from exc
