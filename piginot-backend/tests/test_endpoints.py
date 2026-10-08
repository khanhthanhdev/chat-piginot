from __future__ import annotations

import io
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_get_health():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "loaded_models" in data
    assert "loaded_cases" in data


def test_get_models():
    response = client.get("/models")
    assert response.status_code == 200
    models = response.json()
    assert isinstance(models, list)
    assert len(models) > 0
    runs = [m["run"] for m in models]
    assert "final30_lgo_ginot_lr1e-3" in runs
    model = next(m for m in models if m["run"] == "final30_lgo_ginot_lr1e-3")
    assert model["default"] is True
    assert "trained_on" in model
    assert "recommended" in model


def test_get_cases():
    response = client.get("/cases")
    assert response.status_code == 200
    cases = response.json()
    assert isinstance(cases, list)
    assert len(cases) > 0
    case_ids = [c["case"] for c in cases]
    assert "B001" in case_ids
    assert "B017" in case_ids


def test_get_case_info():
    response = client.get("/cases/B001")
    assert response.status_code == 200
    data = response.json()
    assert data["case"] == "B001"
    assert "room" in data
    assert "min" in data["room"]
    assert "max" in data["room"]
    assert len(data["supply_vents_xy"]) > 0
    assert len(data["return_vents_xy"]) > 0


def test_get_case_info_not_found():
    response = client.get("/cases/NONEXISTENT_CASE")
    assert response.status_code == 404


def test_post_case_load_and_delete_unload():
    # Load case B001
    load_resp = client.post("/cases/B001/load")
    assert load_resp.status_code == 200
    load_data = load_resp.json()
    assert load_data["case"] == "B001"
    assert "setup_s" in load_data
    assert load_data["setup_s"] >= 0

    # Unload case B001
    unload_resp = client.delete("/cases/B001/load")
    assert unload_resp.status_code == 200
    unload_data = unload_resp.json()
    assert "loaded_cases" in unload_data
    assert ("final30_lgo_ginot_lr1e-3", "B001") not in [
        tuple(c) if isinstance(c, list) else c for c in unload_data["loaded_cases"]
    ]


def test_get_case_compare():
    response = client.get("/cases/B001/compare")
    assert response.status_code == 200
    data = response.json()
    assert "velocity_r2" in data
    assert "velocity_mae" in data
    assert "T_mae" in data

def test_get_case_report():
    response = client.get("/cases/B001/report?height=1.1&spacing=0.25&priority=balanced")
    assert response.status_code == 200
    data = response.json()
    assert data["case"] == "B001"
    assert "report_id" in data
    assert "kpis" in data
    assert "composite_score" in data["kpis"]
    assert "mean_velocity" in data["kpis"]
    assert "dead_zone_ratio" in data["kpis"]
    assert "draft_risk_ratio" in data["kpis"]
    assert "compliance_checks" in data
    assert "terminal_schedule" in data


def test_post_predict_json():
    points = [[2.0, 1.5, 1.1], [4.0, 3.0, 1.1]]
    response = client.post("/predict", json={"case": "B001", "points": points})
    assert response.status_code == 200
    data = response.json()
    assert data["case"] == "B001"
    assert data["n_points"] == 2
    assert len(data["u"]) == 2
    assert len(data["v"]) == 2
    assert len(data["w"]) == 2
    assert len(data["T"]) == 2
    assert all(isinstance(val, float) for val in data["u"])


def test_post_predict_outside_handling():
    # Inside + Outside point
    points = [[2.0, 1.5, 1.1], [100.0, 100.0, 100.0]]
    # outside = error
    resp_err = client.post("/predict", json={"case": "B001", "points": points, "outside": "error"})
    assert resp_err.status_code == 422

    # outside = nan
    resp_nan = client.post("/predict", json={"case": "B001", "points": points, "outside": "nan"})
    assert resp_nan.status_code == 200
    data_nan = resp_nan.json()
    assert data_nan["u"][0] is not None
    assert data_nan["u"][1] is None


def test_post_predict_npz():
    points = [[2.0, 1.5, 1.1], [4.0, 3.0, 1.1]]
    response = client.post("/predict?format=npz", json={"case": "B001", "points": points})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert "attachment" in response.headers["content-disposition"]
    buf = io.BytesIO(response.content)
    npz = np.load(buf)
    assert "xyz" in npz.files
    assert "u" in npz.files
    assert "v" in npz.files
    assert "w" in npz.files
    assert "T" in npz.files
    assert npz["xyz"].shape == (2, 3)
    assert npz["u"].shape == (2,)


def test_post_slice():
    response = client.post(
        "/slice",
        json={"case": "B001", "axis": "z", "value": 1.1, "spacing": 0.25},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["case"] == "B001"
    assert data["axis"] == "z"
    assert data["value"] == 1.1
    assert "shape" in data
    shape = tuple(data["shape"])
    assert np.array(data["u"]).shape == shape
    assert np.array(data["v"]).shape == shape
    assert np.array(data["w"]).shape == shape
    assert np.array(data["T"]).shape == shape


def test_post_slice_invalid_spacing():
    response = client.post(
        "/slice",
        json={"case": "B001", "axis": "z", "value": 1.1, "spacing": 0.001},
    )
    assert response.status_code == 422


def test_post_cases_optimize():
    response = client.post(
        "/cases/optimize",
        json={
            "height": 1.1,
            "spacing": 0.3,
            "priority": "balanced",
            "limit": 3,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["priority"] == "balanced"
    assert len(data["candidates"]) > 0
    assert len(data["candidates"]) <= 3
    cand = data["candidates"][0]
    assert "case" in cand
    assert "score" in cand
    assert "kpis" in cand
