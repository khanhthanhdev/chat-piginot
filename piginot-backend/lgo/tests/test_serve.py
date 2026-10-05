"""The inference service gives the same answers as predict.py.

Checks, on the handoff's models and test cases:
  1. parity: engine output equals predict.load + predict_points at the same seed;
  2. sharing: a case registered on an already-loaded model (latent cached,
     another case registered in between) equals a fresh load;
  3. eviction: an evicted case leaves the model's boundary index;
  4. the HTTP endpoints answer (FastAPI TestClient).

Run: python -m tests.test_serve [--device cpu|cuda] [--run NAME] [--cases B001 B017]
Needs ../models and ../test_data from the handoff.
"""

import argparse
import os
import sys

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "legacy"))
HANDOFF = os.path.dirname(ROOT)


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--run", default="final30_lgo_ginot_lr1e-3")
    ap.add_argument("--cases", nargs=2, default=["B001", "B017"])
    ap.add_argument("--atol", type=float, default=1e-4)
    args = ap.parse_args()

    from predict import load, predict_points
    from serve.engine import InferenceEngine

    models = os.environ.get("LGO_MODELS_DIR", os.path.join(HANDOFF, "models"))
    case_roots = os.environ.get("LGO_CASES_DIRS", os.path.join(HANDOFF, "test_data"))
    data = case_roots.split(os.pathsep)
    eng = InferenceEngine(models, data, device=args.device, max_cases=2)
    c1, c2 = args.cases
    rng = np.random.default_rng(0)
    pts = (rng.uniform(0.05, 1.0, (4000, 3)) * np.array([8.7, 6.0, 3.1])).astype(np.float32)
    print(f"device {eng.device} | run {args.run} | cases {c1}, {c2}")

    ok = True
    ref, noise = {}, 0.0
    for c in (c1, c2):
        m, ds = load(os.path.join(models, args.run), eng.cases[c], args.device, seed=0)
        ref[c] = predict_points(m, ds, pts)
        # GINO's graph kernel is not bit-deterministic on GPU: predict.py itself
        # differs between two identical calls. Parity is judged against that.
        noise = max(noise, float(np.abs(predict_points(m, ds, pts) - ref[c]).max()))
        del m, ds
    atol = max(args.atol, 3 * noise)
    print(f"  predict.py repeat noise {noise:.2e} -> tolerance {atol:.2e}")

    def diff(c, out):
        return max(np.abs(out[f] - ref[c][:, i]).max()
                   for f, i in zip(("u", "v", "w", "T"), (0, 1, 2, 4)))

    d1 = diff(c1, eng.predict(args.run, c1, pts))
    ok &= check(f"parity with predict.py on {c1}", d1 < atol, f"max |diff| {d1:.2e}")
    d2 = diff(c2, eng.predict(args.run, c2, pts))
    ok &= check(f"{c2} on the shared model equals a fresh load", d2 < atol, f"max |diff| {d2:.2e}")
    d1b = diff(c1, eng.predict(args.run, c1, pts))
    ok &= check(f"{c1} again after {c2} (cached latent, index switched back)",
                d1b < atol, f"max |diff| {d1b:.2e}")

    model, _ = eng._models[args.run]
    k1 = eng._loaded[(args.run, c1)].key
    k2 = eng._loaded[(args.run, c2)].key
    eng.unload(args.run, c1)
    index = getattr(model, "_index", {})      # host-only models have no boundary index
    ok &= check("unload drops the case", k1 not in index and (args.run, c1) not in eng._loaded)
    eng.max_cases = 1
    d1c = diff(c1, eng.predict(args.run, c1, pts))   # reload c1; LRU evicts c2
    ok &= check(f"{c1} reloaded after eviction", d1c < atol, f"max |diff| {d1c:.2e}")
    ok &= check("LRU eviction at max_cases", k2 not in index
                and list(eng._loaded) == [(args.run, c1)])
    eng.max_cases = 2

    # HTTP layer, on the same engine.
    from fastapi.testclient import TestClient
    from serve import app as appmod
    appmod._engine = eng
    cl = TestClient(appmod.app)
    ok &= check("GET /health", cl.get("/health").status_code == 200)
    ok &= check("GET /models", any(m["run"] == args.run for m in cl.get("/models").json()))
    ok &= check("GET /cases", any(c["case"] == c1 for c in cl.get("/cases").json()))
    info = cl.get(f"/cases/{c1}").json()
    ok &= check("GET /cases/{case} vents", len(info.get("supply_vents_xy", [])) == 3)
    r = cl.post("/predict", json={"case": c1, "run": args.run, "points": pts[:5].tolist()}).json()
    # Against the engine on the same 5 points, not the 4000-point reference:
    # Transolver's attention mixes the query points of one call, so its output
    # at a point depends on the other points queried with it.
    ok &= check("POST /predict", np.allclose(r["u"], eng.predict(args.run, c1, pts[:5])["u"],
                                             atol=atol))
    r = cl.post("/predict", json={"case": c1, "run": args.run, "points": [[1, 1, 1], [9, 1, 1]]})
    ok &= check("POST /predict rejects points outside the room", r.status_code == 422)
    r = cl.post("/predict", json={"case": c1, "run": args.run, "points": [[1, 1, 1], [9, 1, 1]],
                                  "outside": "nan"}).json()
    ok &= check("POST /predict outside='nan'", r["u"][1] is None and r["u"][0] is not None)
    r = cl.post("/slice", json={"case": c1, "run": args.run, "axis": "z", "value": 1.1,
                                "spacing": 0.2}).json()
    ok &= check("POST /slice", np.array(r["T"]).shape == tuple(r["shape"]))
    ok &= check("unknown case -> 404",
                cl.post("/predict", json={"case": "nope", "points": [[1, 1, 1]]}).status_code == 404)

    print("all ok" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
