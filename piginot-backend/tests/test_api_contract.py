from app.main import app


def test_lgo_api_contract_is_exposed() -> None:
    paths = app.openapi()["paths"]

    assert "/health" in paths
    assert "/models" in paths
    assert "/cases" in paths
    assert "/predict" in paths
    assert "/slice" in paths
    assert "/api/hvac-inference" not in paths
    assert "/api/v1/hvac-inference-batch" not in paths
