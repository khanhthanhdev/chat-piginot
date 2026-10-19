"""Writes `src/twin.rs`: the room, the vent layouts and the airflow the video draws, taken from the
handoff's test cases and the LGO-GINOT model through the same engine the app's backend serves.

    LGO_HANDOFF=/path/to/lgo-digital-twin-handoff \
        $LGO_HANDOFF/.venv/bin/python -I tools/twin_data.py

The layout ranking is `InferenceEngine.optimize_layouts` exactly as the app calls it (z = 1.1 m,
0.25 m grid, balanced priority) over every test case. The best layout is the hero: its comfort
slice, probe readings and streamlines traced through the model's predicted field. Room furniture
comes from the case's boundary CSVs.
"""
import os
import sys
import time

import numpy as np
import pandas as pd
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
HANDOFF = os.environ.get("LGO_HANDOFF", os.path.expanduser("~/code/lgo-digital-twin-handoff"))
BACKEND = os.path.join(HERE, "..", "..", "piginot-backend", "lgo")
sys.path[:0] = [BACKEND, os.path.join(BACKEND, "legacy")]

from serve.engine import InferenceEngine, ROOM_MAX  # noqa: E402
from data.splits_cfd_gap import panels  # noqa: E402

RUN = "final30_lgo_ginot_lr1e-3"
HEIGHT, SPACING = 1.1, 0.25
OUT = os.path.join(HERE, "..", "src", "twin.rs")


def furniture(case_dir):
    """(name, x0, y0, x1, y1, z0, z1) boxes. Tables are split into their separate tops."""
    boxes = []
    tops = pd.read_csv(os.path.join(case_dir, "Table.csv"))
    tops = tops[tops["Z (m)"] > 0.8]
    xyz = tops[["X (m)", "Y (m)", "Z (m)"]].to_numpy()
    cell = 0.1
    ij = np.floor(xyz[:, :2] / cell).astype(int)
    mask = np.zeros(ij.max(0) + 2, bool)
    mask[ij[:, 0], ij[:, 1]] = True
    # Greedy rectangles over the occupied cells, so an L-shaped top becomes two boxes; slivers
    # left between them are dropped.
    while mask.any():
        xs, ys = np.nonzero(mask)
        i0, j0 = xs.min(), ys[xs == xs.min()].min()
        j1 = j0
        while j1 + 1 < mask.shape[1] and mask[i0, j1 + 1]:
            j1 += 1
        i1 = i0
        while i1 + 1 < mask.shape[0] and mask[i1 + 1, j0:j1 + 1].all():
            i1 += 1
        mask[i0:i1 + 1, j0:j1 + 1] = False
        x0, y0, x1, y1 = i0 * cell, j0 * cell, (i1 + 1) * cell, (j1 + 1) * cell
        if min(x1 - x0, y1 - y0) >= 0.25:
            inside = (xyz[:, 0] >= x0) & (xyz[:, 0] < x1) & (xyz[:, 1] >= y0) & (xyz[:, 1] < y1)
            boxes.append(("Table", x0, y0, x1, y1, 0.0, float(xyz[inside, 2].max())))
    for name in ["Cabinet_01", "Cabinet_02", "TV", "Sink", "Column", "Board", "Wall_AC", "Door"]:
        d = pd.read_csv(os.path.join(case_dir, f"{name}.csv"))[["X (m)", "Y (m)", "Z (m)"]].to_numpy()
        lo, hi = d.min(0), d.max(0)
        boxes.append((name, lo[0], max(lo[1], 0.0), hi[0], hi[1], lo[2], hi[2]))
    return boxes


def count_tables(case_dir):
    """Separate table tops: connected cells of a 5 cm raster of the top surfaces."""
    tops = pd.read_csv(os.path.join(case_dir, "Table.csv"))
    ij = np.floor(tops.loc[tops["Z (m)"] > 0.8, ["X (m)", "Y (m)"]].to_numpy() / 0.05).astype(int)
    grid = np.zeros(ij.max(0) + 2, bool)
    grid[ij[:, 0], ij[:, 1]] = True
    return ndimage.label(grid)[1]


def trace(engine, case, sup):
    """Streamlines through the predicted field on a 0.2 m grid, seeded under each supply panel."""
    step = 0.2
    axes = [np.arange(step / 2, ROOM_MAX[i], step) for i in range(3)]
    g = np.stack(np.meshgrid(*axes, indexing="ij"), -1).reshape(-1, 3)
    f = engine.predict(RUN, case, g)
    shape = tuple(len(a) for a in axes)
    field = np.stack([f[k].reshape(shape) for k in "uvwT"], -1)

    def sample(p):
        idx = [(p[i] - axes[i][0]) / step for i in range(3)]
        return np.stack([ndimage.map_coordinates(field[..., c], [[x] for x in idx], order=1, mode="nearest")[0]
                         for c in range(4)])

    paths = []
    for sx, sy in sup:
        for ox in (-0.18, 0.0, 0.18):
            for oy in (-0.18, 0.0, 0.18):
                p, t, pts = np.array([sx + ox, sy + oy, 2.95]), 0.0, []
                dt = 0.04
                for n in range(1500):
                    a = sample(p)
                    if n % 5 == 0:
                        pts.append((*p, float(np.linalg.norm(a[:3])), a[3] - 273.15, t))
                    mid = p + 0.5 * dt * a[:3]
                    # Air reaching a wall, the floor or the ceiling slides along it.
                    p = np.clip(p + dt * sample(mid)[:3], 0.03, ROOM_MAX - 0.03)
                    t += dt
                    if np.linalg.norm(a[:3]) < 0.004:
                        break
                pts = np.array(pts)
                if len(pts) > 160:
                    pts = pts[np.linspace(0, len(pts) - 1, 160).round().astype(int)]
                paths.append(pts)
    return paths


def drafty_after(x0, y0, x1, y1, field, axes):
    """Seconds into the probe's 1 s glide (cubic-bezier 0.65, 0, 0.35, 1, as the video's `MOVE`)
    when the reading under it first goes over 0.25 m/s."""
    def ease(t):
        lo, hi = 0.0, 1.0
        for _ in range(40):
            m = (lo + hi) / 2
            x = 3 * (1 - m) ** 2 * m * 0.65 + 3 * (1 - m) * m * m * 0.35 + m ** 3
            lo, hi = (m, hi) if x < t else (lo, m)
        m = (lo + hi) / 2
        return 3 * (1 - m) * m * m + m ** 3
    step = axes["x"][1] - axes["x"][0]
    for t in np.linspace(0, 1, 301):
        q = ease(t)
        fx = (x0 + (x1 - x0) * q - axes["x"][0]) / step
        fy = (y0 + (y1 - y0) * q - axes["y"][0]) / step
        if ndimage.map_coordinates(field, [[fx], [fy]], order=1, mode="nearest")[0] > 0.25:
            return float(t)
    return 1.0


def rust_f32(x):
    return f"{x:.3f}"


def main():
    engine = InferenceEngine(os.path.join(HANDOFF, "models"), [os.path.join(HANDOFF, "test_data")],
                             device="auto", max_cases=2)
    print(f"{len(engine.cases)} cases on {engine.device}", file=sys.stderr)
    t = time.time()
    ranked = engine.optimize_layouts(RUN, HEIGHT, SPACING, "balanced", None, limit=len(engine.cases))
    print(f"ranked in {time.time() - t:.0f} s", file=sys.stderr)
    layouts = ranked["candidates"]
    hero = layouts[0]["case"]

    pts, axes, shape = engine.slice_grid("z", HEIGHT, SPACING)
    t = time.time()
    s = engine.predict(RUN, hero, pts)
    slice_s = time.time() - t
    speed = np.sqrt(s["u"] ** 2 + s["v"] ** 2 + s["w"] ** 2).reshape(shape)
    temp = (s["T"] - 273.15).reshape(shape)

    sup = np.asarray(layouts[0]["supply_vents_xy"])
    # Probe stops: the calmest-to-target spot over the big table, then the fastest air under a vent.
    X, Y = np.meshgrid(axes["x"], axes["y"], indexing="ij")
    table = (X > 2.4) & (X < 5.0) & (Y > 2.4) & (Y < 3.8)
    i = np.argmin(np.where(table, np.abs(speed - 0.15), np.inf))
    interior = (X > 0.6) & (X < ROOM_MAX[0] - 0.6) & (Y > 0.6) & (Y < ROOM_MAX[1] - 0.6)
    near = interior & (np.min(np.hypot(X[..., None] - sup[:, 0], Y[..., None] - sup[:, 1]), -1) < 1.0)
    j = np.argmax(np.where(near, speed, -np.inf))
    probes = [(X.flat[k], Y.flat[k], speed.flat[k], temp.flat[k]) for k in (i, j)]

    # The answer to "Is the meeting area drafty?", over the big table.
    meeting = (X > 2.2) & (X < 7.4) & (Y > 2.2) & (Y < 3.95)
    share = 100.0 * np.count_nonzero(speed[meeting] > 0.25) / np.count_nonzero(meeting)
    if share < 1:
        answer = f"No. Air over the table peaks at {speed[meeting].max():.2f} m/s."
    else:
        verdict = "Mostly not." if share < 20 else "Yes, in places." if share < 50 else "Yes."
        answer = f"{verdict} {share:.0f}% of the table area is over 0.25 m/s."

    # Four layouts the optimizer steps through, in that order: two weaker ones, the best, a runner-up.
    picks = [len(layouts) * 2 // 3, len(layouts) // 4, 0, 8]
    minis = []
    for k in picks:
        m = engine.predict(RUN, layouts[k]["case"], pts)
        minis.append(np.sqrt(m["u"] ** 2 + m["v"] ** 2 + m["w"] ** 2).reshape(shape))

    paths = trace(engine, hero, sup)
    boxes = furniture(engine.cases[hero])
    supply_c = 286.15 - 273.15

    out = ["// Generated by tools/twin_data.py from the LGO handoff test cases and the",
           f"// {RUN} model; do not edit by hand.",
           "",
           f"pub const ROOM: (f32, f32, f32) = ({ROOM_MAX[0]:.2f}, {ROOM_MAX[1]:.2f}, {ROOM_MAX[2]:.2f});",
           f"pub const SUPPLY_C: f32 = {supply_c:.2f};",
           "/// The warm end of the air temperature scale: the 99th percentile along the air paths.",
           f"pub const WARM_C: f32 = {float(np.ceil(np.percentile(np.concatenate([p[:, 4] for p in paths]), 99))):.1f};",
           f"pub const PLANE_Z: f32 = {HEIGHT};",
           "/// Seconds into the probe's move from the table to the vents when it first reads a draft.",
           f"pub const PROBE_DRAFTY_AFTER: f32 = {drafty_after(probes[0][0], probes[0][1], probes[1][0], probes[1][1], speed, axes):.2f};",
           f"pub const TABLES: usize = {count_tables(engine.cases[hero])};",
           f"pub const ANSWER: &str = \"{answer}\";",
           f"/// The layouts the optimizer steps through, as indices into `LAYOUTS`.",
           f"pub const PICKS: [usize; 4] = {picks};",
           "",
           "pub struct Layout {",
           "    pub case: &'static str,",
           "    pub score: f32,",
           "    pub supply: [(f32, f32); 3],",
           "    pub ret: [(f32, f32); 3],",
           "}",
           "",
           "/// Every test layout, best first, as the app's optimizer ranks them.",
           f"pub const LAYOUTS: [Layout; {len(layouts)}] = ["]
    for c in layouts:
        sv = ", ".join(f"({rust_f32(x)}, {rust_f32(y)})" for x, y in c["supply_vents_xy"])
        rv = ", ".join(f"({rust_f32(x)}, {rust_f32(y)})" for x, y in c["return_vents_xy"])
        out.append(f"    Layout {{ case: \"{c['case']}\", score: {c['score']:.1f}, "
                   f"supply: [{sv}], ret: [{rv}] }},")
    out += ["];", ""]
    out.append(f"pub const SLICE_X: [f32; {shape[0]}] = [{', '.join(rust_f32(v) for v in axes['x'])}];")
    out.append(f"pub const SLICE_Y: [f32; {shape[1]}] = [{', '.join(rust_f32(v) for v in axes['y'])}];")
    out.append(f"/// Hero layout air speed (m/s) on the plane, [x][y].")
    out.append(f"pub const SPEED: [[f32; {shape[1]}]; {shape[0]}] = [")
    out += [f"    [{', '.join(rust_f32(v) for v in row)}]," for row in speed]
    out += ["];", f"/// Hero layout air temperature (°C) on the plane, [x][y].",
            f"pub const TEMP: [[f32; {shape[1]}]; {shape[0]}] = ["]
    out += [f"    [{', '.join(f'{v:.2f}' for v in row)}]," for row in temp]
    out += ["];", "/// Air speed (m/s) on the plane for each of `PICKS`, [x][y]."]
    out.append(f"pub const PICK_SPEED: [[[f32; {shape[1]}]; {shape[0]}]; 4] = [")
    for m in minis:
        out.append("    [" + ", ".join("[" + ", ".join(f"{v:.2f}" for v in row) + "]" for row in m) + "],")
    out += ["];", "",
            "/// Probe stops on the plane: x, y, speed (m/s), temperature (°C).",
            "pub const PROBES: [(f32, f32, f32, f32); 2] = ["]
    out += [f"    ({rust_f32(x)}, {rust_f32(y)}, {rust_f32(v)}, {T:.2f})," for x, y, v, T in probes]
    out += ["];", "",
            "/// Furniture boxes: name, x0, y0, x1, y1, z0, z1 (m).",
            f"pub const FURNITURE: [(&str, f32, f32, f32, f32, f32, f32); {len(boxes)}] = ["]
    out += [f"    (\"{b[0]}\", {', '.join(rust_f32(v) for v in b[1:])})," for b in boxes]
    out += ["];", "",
            "/// Streamlines through the hero layout's predicted field: x, y, z (m), speed (m/s),",
            "/// temperature (°C), travel time (s).",
            f"pub const PATHS: [&[(f32, f32, f32, f32, f32, f32)]; {len(paths)}] = ["]
    for p in paths:
        out.append("    &[" + ", ".join(f"({', '.join(rust_f32(v) for v in q)})" for q in p) + "],")
    out += ["];", ""]
    with open(OUT, "w") as fh:
        fh.write("\n".join(out))
    print(answer, file=sys.stderr)
    print(f"hero {hero} score {layouts[0]['score']} | slice {slice_s:.2f} s | probes {probes} | "
          f"{len(paths)} paths, lengths {[len(p) for p in paths]}", file=sys.stderr)
    for c in layouts[:6]:
        print(c["case"], c["score"], c["kpis"], file=sys.stderr)


if __name__ == "__main__":
    main()
