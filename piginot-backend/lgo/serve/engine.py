"""A long-lived inference engine: models loaded once, layouts kept warm.

`predict.py` pays the full setup (read 21 CSVs, build KD-trees, encode the
boundary cloud) on every call. Here each of those is paid once:

- one model instance per run, shared by every case. `build_from_args` reads
  only the run's own normalisation statistics from the dataset, which are the
  same for every case, and `BoundaryLookup.register_cases` keeps one boundary
  index per case keyed by its fingerprint;
- one cached geometry latent per (run, case), so a request only decodes.

Each case is built exactly as `predict.load` builds it (same seed, same
`load_case`, same `register_cases` arguments), so results match the CLI.
"""

import json
import os
import sys
import threading
import time
from collections import OrderedDict

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for p in (ROOT, os.path.join(ROOT, "legacy")):
    if p not in sys.path:
        sys.path.insert(0, p)

from evaluate import build_from_args  # noqa: E402
from predict import load_case  # noqa: E402

RUN_FILES = ("args.json", "best.pth", "thermo_stats.pt")
CASE_FILES = ("New_HVAC.csv", "Fluid_data.csv", "Leak.csv")
# The room's extent in metres (HANDOFF.md, "Input format").
ROOM_MIN = np.array([0.0, 0.0, 0.0])
ROOM_MAX = np.array([8.80, 6.10, 3.20])
FIELDS = ("u", "v", "w", "T")
OUT_COLS = [0, 1, 2, 4]          # model output is u, v, w, p, T; p is not validated


def resolve_device(device):
    if device in (None, "auto"):
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    device = torch.device(device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("device 'cuda' requested but CUDA is not available "
                           "(CPU-only torch build, or no GPU visible); use 'cpu' or 'auto'")
    return device


class _Case:
    __slots__ = ("ds", "latent", "index", "key", "setup_s")

    def __init__(self, ds, latent, index, key, setup_s):
        self.ds, self.latent, self.index, self.key, self.setup_s = ds, latent, index, key, setup_s


class InferenceEngine:
    def __init__(self, models_dir, case_roots, device="auto", max_cases=4,
                 seed=0, chunk=None):
        self.device = resolve_device(device)
        self.max_cases = max(1, int(max_cases))
        self.seed = int(seed)
        self.chunk = int(chunk or (16384 if self.device.type == "cuda" else 8192))
        self.runs = self._discover(models_dir, RUN_FILES)
        self.cases = {}
        for root in ([case_roots] if isinstance(case_roots, str) else case_roots):
            for name, path in self._discover(root, CASE_FILES).items():
                if name in self.cases:
                    raise ValueError(f"case name {name!r} found in two roots: "
                                     f"{self.cases[name]} and {path}")
                self.cases[name] = path
        self._models = {}                 # run -> (model, args)
        self._loaded = OrderedDict()      # (run, case) -> _Case, LRU order
        self._lock = threading.RLock()    # the models and their lookup caches are not thread-safe
        self._kpi_cache = {}
    @staticmethod
    def _discover(root, required):
        if not root or not os.path.isdir(root):
            return {}
        found = {}
        for dirpath, dirnames, filenames in os.walk(root):
            if all(f in filenames for f in required):
                found[os.path.basename(dirpath)] = dirpath
                dirnames[:] = []
        return dict(sorted(found.items()))

    # ------------------------------------------------------------------ #
    #  Loading
    # ------------------------------------------------------------------ #
    def _run_path(self, run):
        if run not in self.runs:
            raise KeyError(f"unknown model {run!r}")
        return self.runs[run]

    def _case_path(self, case):
        if case not in self.cases:
            raise KeyError(f"unknown case {case!r}")
        return self.cases[case]

    def _seed(self):
        np.random.seed(self.seed)
        torch.manual_seed(self.seed)

    def run_args(self, run):
        return json.load(open(os.path.join(self._run_path(run), "args.json")))

    def get_case(self, run, case):
        """Load (or fetch) the model for `run` and prepare `case` on it."""
        key = (run, case)
        with self._lock:
            entry = self._loaded.get(key)
            if entry is not None:
                self._loaded.move_to_end(key)
                return entry
            run_dir, case_dir = self._run_path(run), self._case_path(case)
            t0 = time.time()
            # Same order as predict.load: seed, build the case, (build the model),
            # register the case on it.
            self._seed()
            ds, a = load_case(run_dir, case_dir)
            if run not in self._models:
                model, a = build_from_args(run_dir, ds, self.device)
                self._models[run] = (model, a)
            model, a = self._models[run]
            uses_lookup = getattr(model, "use_local", False) or getattr(model, "use_hbc", False)
            if uses_lookup:
                model.register_cases(ds, verbose=False, normals_k=a.get("normals_k", 16),
                                     with_normals=not a.get("no_normals", False))
            pc = ds.cases[0]["pc_full"].unsqueeze(0).to(self.device)
            with torch.inference_mode():
                latent = model.encode_geometry(pc)
            index, fp = None, None
            if uses_lookup:
                from model.boundary_lookup import fingerprint
                index, fp = model._active, fingerprint(ds.cases[0]["pc_full"][:, :3])
            entry = _Case(ds, latent, index, fp, time.time() - t0)
            self._loaded[key] = entry
            while len(self._loaded) > self.max_cases:
                self._evict(*self._loaded.popitem(last=False))
            return entry

    def _evict(self, key, entry):
        model, _ = self._models[key[0]]
        # Another run's entry for the same case uses another model's index, so
        # only this model's index is dropped.
        if entry.key is not None and hasattr(model, "_index"):
            model._index.pop(entry.key, None)
            model._fp_cache = (None, None)
        if self.device.type == "cuda":
            torch.cuda.empty_cache()

    def unload(self, run=None, case=None):
        with self._lock:
            for key in [k for k in self._loaded
                        if (run is None or k[0] == run) and (case is None or k[1] == case)]:
                self._evict(key, self._loaded.pop(key))

    # ------------------------------------------------------------------ #
    #  Prediction
    # ------------------------------------------------------------------ #
    @staticmethod
    def outside_room(xyz, tol=1e-6):
        """Boolean mask of points outside the room box."""
        return np.any((xyz < ROOM_MIN - tol) | (xyz > ROOM_MAX + tol), axis=1)

    def predict(self, run, case, xyz):
        """(N, 3) points in metres -> dict of u, v, w [m/s] and T [K] arrays."""
        xyz = np.asarray(xyz, dtype=np.float32).reshape(-1, 3)
        with self._lock:
            entry = self.get_case(run, case)
            model, _ = self._models[run]
            ds = entry.ds
            xyz_n = (torch.as_tensor(xyz) - ds.coord_min) / ds.coord_scale
            if entry.index is not None:
                model._active = entry.index      # decode_query reads the case from here
            with torch.inference_mode():
                out = torch.cat([
                    model.decode_query(entry.latent, xyz_n[s:s + self.chunk]
                                       .unsqueeze(0).to(self.device)).squeeze(0).cpu()
                    for s in range(0, len(xyz_n), self.chunk)], 0) if len(xyz_n) else \
                    torch.zeros(0, 5)
            out = (out * ds.target_std[:5] + ds.target_mean[:5]).numpy()
        return {f: out[:, c] for f, c in zip(FIELDS, OUT_COLS)}

    @staticmethod
    def slice_grid(axis, value, spacing, margin=None):
        """Points on an axis-aligned plane through the room, and the grid shape."""
        ax = "xyz".index(axis)
        if not ROOM_MIN[ax] <= value <= ROOM_MAX[ax]:
            raise ValueError(f"{axis}={value} is outside the room "
                             f"[{ROOM_MIN[ax]}, {ROOM_MAX[ax]}]")
        margin = spacing / 2 if margin is None else margin
        others = [i for i in range(3) if i != ax]
        axes = [np.arange(ROOM_MIN[i] + margin, ROOM_MAX[i] - margin + 1e-9, spacing)
                for i in others]
        g0, g1 = np.meshgrid(axes[0], axes[1], indexing="ij")
        pts = np.empty((g0.size, 3), dtype=np.float32)
        pts[:, ax] = value
        pts[:, others[0]] = g0.ravel()
        pts[:, others[1]] = g1.ravel()
        return pts, {"xyz"[others[0]]: axes[0], "xyz"[others[1]]: axes[1]}, g0.shape

    def cfd_points(self, run, case):
        """The case's own interior CFD points and CFD values (as predict.py uses)."""
        with self._lock:
            entry = self.get_case(run, case)
            ds, room = entry.ds, entry.ds.cases[0]
            xyz_n = torch.cat([room["pool_stream_xyz"], room["pool_bg_xyz"]], 0)
            xyz = (xyz_n * ds.coord_scale + ds.coord_min).numpy()
            truth = (torch.cat([room["pool_stream_tgt"], room["pool_bg_tgt"]], 0)
                     * ds.target_std + ds.target_mean).numpy()
        return xyz, truth

    def compare(self, run, case):
        """Prediction vs CFD at the case's own points, with the reported metric function."""
        from thermo.metrics_joint import joint_metrics
        xyz, truth = self.cfd_points(run, case)
        p = self.predict(run, case, xyz)
        pred = np.zeros((len(xyz), 5), dtype=np.float32)
        for f, c in zip(FIELDS, OUT_COLS):
            pred[:, c] = p[f]
        m = joint_metrics(truth, pred)
        return {"n_points": int(len(xyz)), "velocity_r2": float(m["vel_r2"]),
                "velocity_mae": float(m["vel_mae"]), "T_mae": float(m["temp_mae"])}

    # ------------------------------------------------------------------ #
    #  Status
    # ------------------------------------------------------------------ #
    def status(self):
        with self._lock:
            return {
                "device": str(self.device),
                "cuda_available": torch.cuda.is_available(),
                "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                "loaded_models": sorted(self._models),
                "loaded_cases": [{"run": r, "case": c, "setup_s": round(e.setup_s, 2)}
                                 for (r, c), e in self._loaded.items()],
                "max_cases": self.max_cases,
                "seed": self.seed,
            }

    # ------------------------------------------------------------------ #
    #  Comfort KPIs & Layout Optimization
    # ------------------------------------------------------------------ #
    @staticmethod
    def compute_comfort_kpis(slice_dict: dict[str, np.ndarray], priority: str = "balanced") -> dict[str, float]:
        """Compute ASHRAE 55 occupied-plane comfort KPIs and composite score."""
        u = slice_dict.get("u")
        v = slice_dict.get("v")
        w = slice_dict.get("w")
        T = slice_dict.get("T")
        if u is None or v is None or w is None:
            return {
                "composite_score": 0.0,
                "mean_velocity": 0.0,
                "max_velocity": 0.0,
                "dead_zone_ratio": 0.0,
                "air_sweep_coverage": 0.0,
                "draft_risk_ratio": 0.0,
                "temp_uniformity": 0.0,
            }
        V = np.sqrt(u**2 + v**2 + w**2)
        valid = ~np.isnan(V)
        if not np.any(valid):
            return {
                "composite_score": 0.0,
                "mean_velocity": 0.0,
                "max_velocity": 0.0,
                "dead_zone_ratio": 0.0,
                "air_sweep_coverage": 0.0,
                "draft_risk_ratio": 0.0,
                "temp_uniformity": 0.0,
            }
        total_pts = int(np.count_nonzero(valid))
        mean_vel = float(np.mean(V[valid]))
        max_vel = float(np.max(V[valid]))
        dead_zone_ratio = float(np.count_nonzero(V[valid] < 0.10) / total_pts)
        air_sweep_coverage = float(np.count_nonzero((V[valid] >= 0.10) & (V[valid] <= 0.30)) / total_pts)
        draft_risk_ratio = float(np.count_nonzero(V[valid] > 0.25) / total_pts)

        if T is not None and np.any(valid):
            t_mean = float(np.mean(T[valid]))
            t_std = float(np.std(T[valid]))
            temp_uniformity = float(np.clip(1.0 - (t_std / max(1e-4, t_mean)), 0.0, 1.0))
        else:
            temp_uniformity = 1.0

        if priority == "minimize_draft":
            w_sweep, w_dead, w_draft, w_temp = 0.25, 0.15, 0.50, 0.10
        elif priority == "eliminate_dead_zones":
            w_sweep, w_dead, w_draft, w_temp = 0.30, 0.50, 0.10, 0.10
        else:
            w_sweep, w_dead, w_draft, w_temp = 0.35, 0.25, 0.25, 0.15

        composite_score = round(float(100.0 * np.clip(
            w_sweep * air_sweep_coverage
            + w_dead * (1.0 - dead_zone_ratio)
            + w_draft * (1.0 - draft_risk_ratio)
            + w_temp * temp_uniformity,
            0.0, 1.0
        )), 1)

        return {
            "composite_score": composite_score,
            "mean_velocity": round(mean_vel, 3),
            "max_velocity": round(max_vel, 3),
            "dead_zone_ratio": round(dead_zone_ratio, 3),
            "air_sweep_coverage": round(air_sweep_coverage, 3),
            "draft_risk_ratio": round(draft_risk_ratio, 3),
            "temp_uniformity": round(temp_uniformity, 3),
        }

    def optimize_layouts(self, run: str, height: float = 1.1, spacing: float = 0.25,
                         priority: str = "balanced", target_supply_vents: list[list[float]] | None = None,
                         limit: int = 5) -> dict:
        from data.splits_cfd_gap import panels
        candidates = []
        h_key = round(height, 2)
        s_key = round(spacing, 2)

        for case in self.cases:
            cache_key = (run, case, h_key, s_key)
            with self._lock:
                if cache_key in self._kpi_cache:
                    cached_kpi = self._kpi_cache[cache_key]
                    kpi = dict(cached_kpi)
                    if priority == "minimize_draft":
                        w_sweep, w_dead, w_draft, w_temp = 0.25, 0.15, 0.50, 0.10
                    elif priority == "eliminate_dead_zones":
                        w_sweep, w_dead, w_draft, w_temp = 0.30, 0.50, 0.10, 0.10
                    else:
                        w_sweep, w_dead, w_draft, w_temp = 0.35, 0.25, 0.25, 0.15
                    kpi["composite_score"] = round(float(100.0 * np.clip(
                        w_sweep * kpi["air_sweep_coverage"]
                        + w_dead * (1.0 - kpi["dead_zone_ratio"])
                        + w_draft * (1.0 - kpi["draft_risk_ratio"])
                        + w_temp * kpi["temp_uniformity"],
                        0.0, 1.0
                    )), 1)
                else:
                    pts, _, _ = self.slice_grid("z", height, spacing)
                    slice_dict = self.predict(run, case, pts)
                    kpi = self.compute_comfort_kpis(slice_dict, priority=priority)
                    self._kpi_cache[cache_key] = kpi

            sup, ret = panels(self.cases[case])
            if target_supply_vents and len(target_supply_vents) > 0 and len(sup) > 0:
                targets = np.asarray(target_supply_vents, dtype=np.float32)
                dists = np.linalg.norm(targets[:, None, :] - sup[None, :, :], axis=-1)
                min_dists = np.min(dists, axis=1)
                d = float(np.mean(min_dists))
                final_score = round(max(0.0, kpi["composite_score"] - min(25.0, d * 5.0)), 1)
            else:
                final_score = kpi["composite_score"]

            candidate_record = {
                "case": case,
                "set": os.path.basename(os.path.dirname(self.cases[case])),
                "score": final_score,
                "kpis": kpi,
                "supply_vents_xy": sup.tolist(),
                "return_vents_xy": ret.tolist(),
            }
            candidates.append(candidate_record)

        candidates.sort(key=lambda c: c["score"], reverse=True)
        top_candidates = candidates[:limit]

        return {
            "run": run,
            "height": height,
            "priority": priority,
            "recommended_case": top_candidates[0]["case"] if top_candidates else None,
            "candidates": top_candidates,
        }

    def generate_case_report(self, run: str, case: str, height: float = 1.1, spacing: float = 0.25,
                             priority: str = "balanced") -> dict:
        from data.splits_cfd_gap import panels
        if case not in self.cases:
            raise KeyError(f"Unknown case: {case}")

        h_key = round(height, 2)
        s_key = round(spacing, 2)
        cache_key = (run, case, h_key, s_key)

        with self._lock:
            if cache_key in self._kpi_cache:
                cached_kpi = self._kpi_cache[cache_key]
                kpi = dict(cached_kpi)
                if priority == "minimize_draft":
                    w_sweep, w_dead, w_draft, w_temp = 0.25, 0.15, 0.50, 0.10
                elif priority == "eliminate_dead_zones":
                    w_sweep, w_dead, w_draft, w_temp = 0.30, 0.50, 0.10, 0.10
                else:
                    w_sweep, w_dead, w_draft, w_temp = 0.35, 0.25, 0.25, 0.15
                kpi["composite_score"] = round(float(100.0 * np.clip(
                    w_sweep * kpi["air_sweep_coverage"]
                    + w_dead * (1.0 - kpi["dead_zone_ratio"])
                    + w_draft * (1.0 - kpi["draft_risk_ratio"])
                    + w_temp * kpi["temp_uniformity"],
                    0.0, 1.0
                )), 1)
            else:
                pts, _, _ = self.slice_grid("z", height, spacing)
                slice_dict = self.predict(run, case, pts)
                kpi = self.compute_comfort_kpis(slice_dict, priority=priority)
                self._kpi_cache[cache_key] = kpi

        sup, ret = panels(self.cases[case])

        terminals = []
        for i, pt in enumerate(sup):
            terminals.append({
                "id": f"SUP-{i + 1:02d}",
                "type": "Supply Diffuser",
                "x": round(float(pt[0]), 2),
                "y": round(float(pt[1]), 2),
                "z": 3.20,
                "function": "Conditioned Air Supply",
            })
        for i, pt in enumerate(ret):
            terminals.append({
                "id": f"RET-{i + 1:02d}",
                "type": "Return Grille",
                "x": round(float(pt[0]), 2),
                "y": round(float(pt[1]), 2),
                "z": 3.20,
                "function": "Return Air Extraction",
            })

        sweep_pct = round(kpi["air_sweep_coverage"] * 100.0, 1)
        dead_pct = round(kpi["dead_zone_ratio"] * 100.0, 1)
        draft_pct = round(kpi["draft_risk_ratio"] * 100.0, 1)
        temp_pct = round(kpi["temp_uniformity"] * 100.0, 1)

        sweep_status = "PASS" if sweep_pct >= 60.0 else ("MARGINAL" if sweep_pct >= 45.0 else "FAIL")
        dead_status = "PASS" if dead_pct <= 20.0 else ("MARGINAL" if dead_pct <= 35.0 else "FAIL")
        draft_status = "PASS" if draft_pct <= 15.0 else ("MARGINAL" if draft_pct <= 25.0 else "FAIL")
        temp_status = "PASS" if temp_pct >= 90.0 else ("MARGINAL" if temp_pct >= 80.0 else "FAIL")

        score = kpi["composite_score"]
        has_fail = any(s == "FAIL" for s in (sweep_status, dead_status, draft_status, temp_status))
        if score >= 75.0 and not has_fail:
            overall_verdict = "COMPLIANT"
            summary_statement = (
                f"Airflow distribution in Case {case} satisfies ASHRAE 55-2023 thermal comfort parameters "
                f"with an effective air-sweep coverage of {sweep_pct}% and low draft discomfort risk ({draft_pct}%)."
            )
        elif score >= 55.0:
            overall_verdict = "CONDITIONALLY COMPLIANT"
            summary_statement = (
                f"Case {case} meets conditional comfort benchmarks (Composite Score: {score}/100). "
                f"Stagnant dead-zone ratio is {dead_pct}% with {draft_pct}% draft risk in occupied breathing zone."
            )
        else:
            overall_verdict = "NON-COMPLIANT"
            summary_statement = (
                f"Case {case} fails acceptable occupant comfort thresholds (Composite Score: {score}/100) "
                f"due to elevated dead zones ({dead_pct}%) or draft concentration."
            )

        compliance_checks = [
            {
                "parameter": "Occupied Air-Sweep Effective Circulation (0.10 - 0.30 m/s)",
                "standard": "ASHRAE 55-2023 §5.3.3",
                "target": "≥ 60.0%",
                "measured": f"{sweep_pct}%",
                "status": sweep_status,
            },
            {
                "parameter": "Stagnant Air Dead-Zone Ratio (< 0.10 m/s)",
                "standard": "ASHRAE 55-2023 §5.3.4",
                "target": "≤ 20.0%",
                "measured": f"{dead_pct}%",
                "status": dead_status,
            },
            {
                "parameter": "Occupant Draft Discomfort Risk (> 0.25 m/s)",
                "standard": "ASHRAE 55-2023 §5.4.1",
                "target": "≤ 15.0%",
                "measured": f"{draft_pct}%",
                "status": draft_status,
            },
            {
                "parameter": "Breathing-Plane Thermal Uniformity (1 - σ_T / T̄)",
                "standard": "ASHRAE 55-2023 §5.2.1",
                "target": "≥ 90.0%",
                "measured": f"{temp_pct}%",
                "status": temp_status,
            },
        ]

        return {
            "report_id": f"REP-HVAC-{case}-{int(time.time())}",
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
            "case": case,
            "dataset_set": os.path.basename(os.path.dirname(self.cases[case])),
            "run": run,
            "standard": "ASHRAE Standard 55-2023",
            "evaluation_plane": {
                "axis": "z",
                "height_m": height,
                "spacing_m": spacing,
                "description": "Seated Occupant Breathing Zone",
            },
            "room": {
                "length_x_m": float(ROOM_MAX[0] - ROOM_MIN[0]),
                "width_y_m": float(ROOM_MAX[1] - ROOM_MIN[1]),
                "height_z_m": float(ROOM_MAX[2] - ROOM_MIN[2]),
                "floor_area_m2": round(float((ROOM_MAX[0] - ROOM_MIN[0]) * (ROOM_MAX[1] - ROOM_MIN[1])), 2),
                "volume_m3": round(float(np.prod(ROOM_MAX - ROOM_MIN)), 2),
            },
            "optimization_priority": priority,
            "composite_score": score,
            "overall_verdict": overall_verdict,
            "summary_statement": summary_statement,
            "kpis": kpi,
            "compliance_checks": compliance_checks,
            "terminal_schedule": terminals,
            "supply_count": len(sup),
            "return_count": len(ret),
        }
