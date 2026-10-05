#!/usr/bin/env python
"""Predict velocity (u, v, w) and temperature T in a room with one trained model.

    python predict.py --run ../models/final30_lgo_ginot_lr1e-3 \
        --case ../test_data/gap30/B001 --out B001_pred.csv

    python predict.py --run ../models/final30_lgo_ginot_lr1e-3 \
        --case ../test_data/gap30/B001 --query my_points.csv --out my_pred.csv

Inputs
  --run    a model directory: args.json, best.pth, thermo_stats.pt
  --case   a case directory with the 21 CSVs (see HANDOFF.md, "Input format")
  --query  optional CSV with columns x, y, z in metres. Without it, the model is
           queried at every interior CFD point of the case and the output also
           carries the CFD values and a short accuracy summary.

Output (CSV, or .npz if --out ends in .npz)
  x, y, z [m], u, v, w [m/s], T [K]; plus u_cfd, v_cfd, w_cfd, T_cfd when the
  query points are the case's own CFD points.

The model is loaded and fed exactly as evaluate.py does for the reported
results: the run's own args.json and normalisation statistics, and return-vent
velocities hidden from the input when the run was trained that way.
"""

import argparse
import json
import os
import sys
import time

import numpy as np
import torch

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "legacy"))

from evaluate import build_from_args  # noqa: E402


def load_case(run, case_dir):
    """The case as the model sees it, built with the run's own statistics."""
    from thermo.dataset import PC_CLS, ThermoDataset
    a = json.load(open(os.path.join(run, "args.json")))
    stats = os.path.join(run, "thermo_stats.pt")
    if not os.path.exists(stats):
        raise SystemExit(f"{run}: thermo_stats.pt not found; the model cannot be "
                         f"used without the normalisation it was trained with")
    ds = ThermoDataset(case_dirs=[case_dir.rstrip("/")], saved_stats=stats,
                       stats_path=stats, n_case_pool=1_500_000,
                       n_boundary_pool=250_000, n_pc=15000, pc_mode="full")
    if a.get("blind_return_velocity"):
        # Return vents are outlets: their velocity is solver output, so the
        # model was trained without it. Keep their position and class only.
        pc = ds.cases[0]["pc_full"]
        pc[pc[:, PC_CLS].argmax(dim=-1) == 3, 8:11] = 0.0
    return ds, a


def load(run, case_dir, device="cuda", seed=0):
    """Load one model for one case. Returns (model, ds); the case is ds.cases[0].

    Do this once per (model, layout); then call predict_points as often as needed.
    """
    np.random.seed(seed)
    torch.manual_seed(seed)
    device = torch.device(device)
    ds, a = load_case(run, case_dir)
    model, a = build_from_args(run, ds, device)
    if getattr(model, "use_local", False) or getattr(model, "use_hbc", False):
        model.register_cases(ds, verbose=False, normals_k=a.get("normals_k", 16),
                             with_normals=not a.get("no_normals", False))
    return model, ds


def predict_points(model, ds, xyz, chunk=16384):
    """(N, 3) points in metres -> (N, 5) array [u, v, w, p, T] in m/s, Pa, K.

    Column 3 (pressure) is not a validated output; use u, v, w and T.
    """
    device = next(model.parameters()).device
    xyz_n = (torch.as_tensor(np.asarray(xyz, dtype=np.float32)) - ds.coord_min) / ds.coord_scale
    out = run_model(model, ds.cases[0], xyz_n, device, chunk)
    return (out * ds.target_std[:5] + ds.target_mean[:5]).numpy()


@torch.no_grad()
def run_model(model, room, xyz_n, device, chunk):
    lat = model.encode_geometry(room["pc_full"].unsqueeze(0).to(device))
    return torch.cat([
        model.decode_query(lat, xyz_n[s:s + chunk].unsqueeze(0).to(device)).squeeze(0)
        for s in range(0, len(xyz_n), chunk)], 0).cpu()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run", required=True)
    ap.add_argument("--case", required=True)
    ap.add_argument("--query", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--chunk", type=int, default=16384)
    ap.add_argument("--seed", type=int, default=0,
                    help="fixes the boundary-cloud subsample, so repeated runs agree")
    args = ap.parse_args()

    device = torch.device(args.device)
    t0 = time.time()
    model, ds = load(args.run, args.case, device, args.seed)
    room = ds.cases[0]
    t_setup = time.time() - t0

    tm, ts = ds.target_mean, ds.target_std
    if args.query:
        import pandas as pd
        q = pd.read_csv(args.query)
        missing = [c for c in ("x", "y", "z") if c not in q.columns]
        if missing:
            raise SystemExit(f"{args.query}: missing column(s) {missing}; need x, y, z in metres")
        xyz = q[["x", "y", "z"]].to_numpy(dtype=np.float32)
        truth = None
    else:
        # The case's own CFD points, recovered from the loader's normalised pools.
        xyz_n = torch.cat([room["pool_stream_xyz"], room["pool_bg_xyz"]], 0)
        xyz = (xyz_n * ds.coord_scale + ds.coord_min).numpy()
        truth = (torch.cat([room["pool_stream_tgt"], room["pool_bg_tgt"]], 0) * ts + tm).numpy()

    t1 = time.time()
    pred = predict_points(model, ds, xyz, args.chunk)
    t_pred = time.time() - t1

    cols = {"x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2],
            "u": pred[:, 0], "v": pred[:, 1], "w": pred[:, 2], "T": pred[:, 4]}
    if truth is not None:
        cols.update({"u_cfd": truth[:, 0], "v_cfd": truth[:, 1],
                     "w_cfd": truth[:, 2], "T_cfd": truth[:, 4]})
    if args.out.endswith(".npz"):
        np.savez_compressed(args.out, **cols)
    else:
        import pandas as pd
        # Full precision: rounding the coordinates moves the query point.
        pd.DataFrame(cols).to_csv(args.out, index=False)

    print(f"{os.path.basename(args.case.rstrip('/'))}: {len(xyz):,} points | "
          f"setup {t_setup:.1f} s, prediction {t_pred:.1f} s on {device} | wrote {args.out}")
    if truth is not None:
        # The same metric function as the reported results (results/test/*.json,
        # "per_case"): velocity scored on u, v, w together.
        from thermo.metrics_joint import joint_metrics
        m = joint_metrics(truth, pred)
        print(f"  against CFD: velocity R2 {m['vel_r2']:+.4f} | velocity MAE "
              f"{m['vel_mae']:.4f} m/s | T MAE {m['temp_mae']:.4f} K")


if __name__ == "__main__":
    main()
