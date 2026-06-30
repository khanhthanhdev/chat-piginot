from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from .schemas import HvacInferenceBatchRequest, HvacInferenceBatchResponse
from .services.batch_inference_service import execute_batch_inference
from .services.execution import run_inference_in_worker


router = APIRouter(prefix="/api/v1", tags=["ginot-batch"])


@router.post(
    "/hvac-inference-batch",
    response_model=HvacInferenceBatchResponse,
    summary="Independent six-terminal HVAC batch inference",
)
async def hvac_inference_batch(
    request: HvacInferenceBatchRequest,
) -> HvacInferenceBatchResponse:
    try:
        return await run_inference_in_worker(lambda: execute_batch_inference(request))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
