"""HTTP API over `InferenceEngine`.

Configuration (environment):
  LGO_MODELS_DIR   directory of run folders            (default: ../models)
  LGO_CASES_DIRS   case roots, separated by ':'        (default: ../test_data)
  LGO_DEVICE       auto | cpu | cuda | cuda:N          (default: auto)
  LGO_MAX_CASES    (model, layout) pairs kept warm     (default: 4)
  LGO_DEFAULT_RUN  model used when a request names none (default: final30_lgo_ginot_lr1e-3)
  LGO_SEED         boundary-subsample seed             (default: 0, as the reported results)
  LGO_MAX_POINTS   largest query per request           (default: 1,000,000)
"""

import csv
import io
import os
from contextlib import asynccontextmanager
from typing import List, Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from serve.engine import ROOM_MAX, ROOM_MIN, InferenceEngine

HERE = os.path.dirname(os.path.abspath(__file__))
HANDOFF = os.path.abspath(os.path.join(HERE, "..", ".."))

MODELS_DIR = os.environ.get("LGO_MODELS_DIR", os.path.join(HANDOFF, "models"))
CASES_DIRS = os.environ.get("LGO_CASES_DIRS", os.path.join(HANDOFF, "test_data")).split(":")
DEFAULT_RUN = os.environ.get("LGO_DEFAULT_RUN", "final30_lgo_ginot_lr1e-3")
MAX_POINTS = int(os.environ.get("LGO_MAX_POINTS", 1_000_000))
SUMMARY_CSV = os.path.join(HANDOFF, "results", "summary.csv")
RECOMMENDED = {"final30_lgo_ginot_lr1e-3", "final58_lgo_gino_lr3e-3"}

_engine: Optional[InferenceEngine] = None


def engine() -> InferenceEngine:
    global _engine
    if _engine is None:
        _engine = InferenceEngine(
            MODELS_DIR, CASES_DIRS,
            device=os.environ.get("LGO_DEVICE", "auto"),
            max_cases=int(os.environ.get("LGO_MAX_CASES", 4)),
            seed=int(os.environ.get("LGO_SEED", 0)))
    return _engine


@asynccontextmanager
async def lifespan(_app: FastAPI):
    runtime = engine()
    if DEFAULT_RUN not in runtime.runs:
        raise RuntimeError(
            f"Default model {DEFAULT_RUN!r} is missing from {MODELS_DIR}; "
            "set LGO_DEFAULT_RUN to an installed model run"
        )
    if not runtime.cases:
        raise RuntimeError(
            f"No precomputed CFD cases were found in {CASES_DIRS}; "
            "set LGO_CASES_DIRS to one or more case roots"
        )
    yield


app = FastAPI(
    title="LGO indoor-airflow inference",
    description="Velocity (u, v, w) and temperature T in the room, "
    "for one of the trained models and one vent layout.",
    lifespan=lifespan,
)
cors_origins = [
    origin.strip()
    for origin in os.environ.get("LGO_CORS_ALLOW_ORIGINS", "").split(",")
    if origin.strip()
]
if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["content-type"],
    )


def _call(fn, *a):
    try:
        return fn(*a)
    except KeyError as e:
        raise HTTPException(404, str(e.args[0]) if e.args else str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))


async def _run(fn, *a):
    return await run_in_threadpool(_call, fn, *a)


def _summary():
    if not os.path.exists(SUMMARY_CSV):
        return {}
    with open(SUMMARY_CSV) as f:
        return {r["run"]: r for r in csv.DictReader(f) if r.get("run")}


# ---------------------------------------------------------------------- #
#  Request bodies
# ---------------------------------------------------------------------- #
class PredictRequest(BaseModel):
    case: str
    run: Optional[str] = None
    points: List[List[float]] = Field(..., description="[[x, y, z], ...] in metres")
    outside: Literal["error", "nan"] = Field(
        "error", description="points outside the room: reject the request, or return NaN for them")


class SliceRequest(BaseModel):
    case: str
    run: Optional[str] = None
    axis: Literal["x", "y", "z"] = "z"
    value: float = Field(1.1, description="plane position in metres")
    spacing: float = Field(0.1, gt=0.005, le=2.0, description="grid spacing in metres")


def _fields(out, mask=None):
    res = {}
    for k, v in out.items():
        v = v.astype(np.float64)
        if mask is None:
            res[k] = v.tolist()
            continue
        full = np.full(mask.shape, np.nan)
        full[~mask] = v
        # JSON has no NaN; send null.
        res[k] = [None if np.isnan(x) else x for x in full.tolist()]
    return res


# ---------------------------------------------------------------------- #
#  Endpoints
# ---------------------------------------------------------------------- #
@app.get("/health")
def health():
    return engine().status()


@app.get("/models")
def models():
    eng, summ = engine(), _summary()
    out = []
    for run in eng.runs:
        a = eng.run_args(run)
        rows = summ.get(run, {})
        out.append({
            "run": run,
            "architecture": rows.get("model", a.get("model")),
            "trained_on": "gap-0.58" if run.startswith("final58") else "gap-0.30",
            "recommended": run in RECOMMENDED,
            "default": run == DEFAULT_RUN,
            "test": {k: rows[k] for k in ("test_split", "velocity_R2", "T_MAE_K") if k in rows},
        })
    return out


@app.get("/cases")
def cases():
    eng = engine()
    return [{"case": c, "set": os.path.basename(os.path.dirname(p))} for c, p in eng.cases.items()]


@app.get("/cases/{case}")
async def case_info(case: str):
    path = _call(engine()._case_path, case)

    def info():
        from data.splits_cfd_gap import panels
        sup, ret = panels(path)
        return {"case": case, "room": {"min": ROOM_MIN.tolist(), "max": ROOM_MAX.tolist()},
                "supply_vents_xy": sup.tolist(), "return_vents_xy": ret.tolist()}
    return await _run(info)


@app.post("/cases/{case}/load")
async def load(case: str, run: Optional[str] = Query(None)):
    run = run or DEFAULT_RUN
    entry = await _run(engine().get_case, run, case)
    return {"run": run, "case": case, "setup_s": round(entry.setup_s, 2)}


@app.delete("/cases/{case}/load")
async def unload(case: str, run: Optional[str] = Query(None)):
    await _run(engine().unload, run, case)
    return engine().status()


@app.get("/cases/{case}/compare")
async def compare(case: str, run: Optional[str] = Query(None)):
    run = run or DEFAULT_RUN
    return {"run": run, "case": case, **(await _run(engine().compare, run, case))}


@app.post("/predict")
async def predict(req: PredictRequest, format: Literal["json", "npz"] = "json"):
    run = req.run or DEFAULT_RUN
    if len(req.points) > MAX_POINTS:
        raise HTTPException(413, f"{len(req.points):,} points; the limit is {MAX_POINTS:,}")
    try:
        xyz = np.asarray(req.points, dtype=np.float32).reshape(-1, 3)
    except ValueError:
        raise HTTPException(422, "points must be a list of [x, y, z]")
    outside = InferenceEngine.outside_room(xyz)
    if outside.any() and req.outside == "error":
        i = int(np.argmax(outside))
        raise HTTPException(422, f"{int(outside.sum())} point(s) outside the room "
                                 f"{ROOM_MIN.tolist()}-{ROOM_MAX.tolist()} m, first: index {i} "
                                 f"{xyz[i].tolist()}; pass outside='nan' to get NaN for them")
    out = await _run(engine().predict, run, req.case, xyz[~outside])
    if format == "npz":
        full = {}
        for k, v in out.items():
            full[k] = np.full(len(xyz), np.nan, dtype=np.float32)
            full[k][~outside] = v
        buf = io.BytesIO()
        np.savez_compressed(buf, xyz=xyz, **full)
        return Response(buf.getvalue(), media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{req.case}_pred.npz"'})
    return {"run": run, "case": req.case, "n_points": len(xyz),
            **_fields(out, outside if outside.any() else None)}


@app.post("/slice")
async def slice_(req: SliceRequest):
    run = req.run or DEFAULT_RUN
    try:
        pts, axes, shape = InferenceEngine.slice_grid(req.axis, req.value, req.spacing)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if len(pts) > MAX_POINTS:
        raise HTTPException(413, f"{len(pts):,} grid points; increase spacing")
    out = await _run(engine().predict, run, req.case, pts)
    # Fields are row-major over (first axis, second axis), as listed in "axes".
    return {"run": run, "case": req.case, "axis": req.axis, "value": req.value,
            "shape": list(shape), "axes": {k: v.round(6).tolist() for k, v in axes.items()},
            **{k: np.asarray(v, dtype=np.float64).reshape(shape).round(6).tolist()
               for k, v in out.items()}}
