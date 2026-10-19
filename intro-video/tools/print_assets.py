"""Print charts for the A4 flyer and the standee, from the same data as the video.

    $LGO_HANDOFF/.venv/bin/python -I tools/print_assets.py

Reads `src/twin.rs` (the room, the best layout's predicted plane) and the handoff's
`results/summary.csv`, and writes every chart to `print/charts/` twice, on the video's dark
surface and on white, each as a 300 dpi PNG and a vector PDF.
"""
import csv
import os
import re

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, ListedColormap  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
HANDOFF = os.environ.get("LGO_HANDOFF", os.path.expanduser("~/code/lgo-digital-twin-handoff"))
OUT = os.path.join(ROOT, "print", "charts")

for f in os.listdir(os.path.join(ROOT, "media")):
    if f.endswith(".ttf"):
        font_manager.fontManager.addfont(os.path.join(ROOT, "media", f))

# The video's palette.
CYAN, GOOD, COOL, STILL, AMBER = "#22d3ee", "#34d399", "#38bdf8", "#64748b", "#f59e0b"
THEMES = {
    "dark": dict(accent=CYAN, bg="#0c0e11", ink="#ededef", ink2="#9aa0aa", muted="#4a4f58", grid="#22262d",
                 context="#4a4f58", furniture="#1d222a", edge="#3a404a"),
    "light": dict(accent="#0891b2", bg="#ffffff", ink="#0b0b0b", ink2="#52514e", muted="#9a9890", grid="#e4e3df",
                  context="#bdbbb4", furniture="#eceae5", edge="#9a9890"),
}


def twin():
    s = open(os.path.join(ROOT, "src", "twin.rs")).read()

    def const(name):
        return s[s.index(f"pub const {name}"):].split(";\n", 1)[0]

    nums = lambda t: [float(v) for v in re.findall(r"-?\d+\.\d+|-?\d+", t)]
    def grid(name):
        body = const(name).split("= [", 1)[1]
        return np.array([nums(r) for r in body.splitlines() if r.strip().startswith("[")])
    best = re.search(r'Layout \{ case: "(\w+)", score: ([\d.]+), supply: \[(.*?)\], ret: \[(.*?)\]', s)
    pairs = lambda t: np.array(nums(t)).reshape(-1, 2)
    furniture = re.findall(r'\("(\w+)", ([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)',
                           const("FURNITURE"))
    return dict(
        room=nums(const("ROOM").split("=")[1]),
        x=np.array(nums(const("SLICE_X").split("= [")[1])),
        y=np.array(nums(const("SLICE_Y").split("= [")[1])),
        speed=grid("SPEED"), temp=grid("TEMP"),
        case=best.group(1), score=float(best.group(2)),
        supply=pairs(best.group(3)), ret=pairs(best.group(4)),
        furniture=[(n, *map(float, v)) for n, *v in furniture],
    )


def style(t):
    plt.rcParams.update({
        "font.family": "Inter", "font.size": 11, "text.color": t["ink"],
        "axes.facecolor": t["bg"], "figure.facecolor": t["bg"], "savefig.facecolor": t["bg"],
        "axes.edgecolor": t["grid"], "axes.labelcolor": t["ink2"],
        "xtick.color": t["ink2"], "ytick.color": t["ink2"], "axes.titlecolor": t["ink"],
    })


def save(fig, name, theme):
    os.makedirs(OUT, exist_ok=True)
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(OUT, f"{name}_{theme}.{ext}"), dpi=300, bbox_inches="tight", pad_inches=0.25)
    plt.close(fig)


def accuracy(t, theme):
    """Velocity R² per model on both test sets, LGO highlighted against the plain hosts."""
    rows = list(csv.DictReader(open(os.path.join(HANDOFF, "results", "summary.csv"))))
    fig, axes = plt.subplots(1, 2, figsize=(9.2, 3.9), sharey=False)
    sets = [("gap-0.30", "Layouts near the training set", "21 test layouts"),
            ("gap-0.58", "Layouts far from the training set", "25 test layouts")]
    for ax, (split, title, n) in zip(axes, sets):
        data = [r for r in rows if r["test_split"] == split and r["model"] != "null: training-set mean"]
        data.sort(key=lambda r: float(r["velocity_R2"]))
        names = ["Nearest-layout lookup" if r["model"].startswith("null") else r["model"] for r in data]
        vals = [float(r["velocity_R2"]) for r in data]
        colors = [t["accent"] if n.startswith("LGO") else t["context"] for n in names]
        y = np.arange(len(data))
        ax.barh(y, [max(v, 0) for v in vals], height=0.62, color=colors, zorder=2)
        for yi, v, name in zip(y, vals, names):
            ax.text(max(v, 0) + 0.015, yi, f"{v:.3f}".replace("-", "−"), va="center", fontsize=9.5,
                    color=t["ink"] if name.startswith("LGO") else t["ink2"],
                    fontweight=600 if name.startswith("LGO") else 400)
        ax.set_yticks(y, names, fontsize=10)
        for lab, name in zip(ax.get_yticklabels(), names):
            lab.set_color(t["ink"] if name.startswith("LGO") else t["ink2"])
            lab.set_fontweight(600 if name.startswith("LGO") else 400)
        ax.set_xlim(0, 1.12)
        ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
        ax.grid(axis="x", color=t["grid"], lw=0.8, zorder=0)
        ax.tick_params(length=0)
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
        ax.set_title(f"{title}\n", loc="left", fontsize=12, fontweight=600)
        ax.text(0, 1.02, n, transform=ax.transAxes, fontsize=9.5, color=t["ink2"])
        ax.set_xlabel("Velocity R², whole room (1.0 = CFD)", fontsize=9.5)
    fig.tight_layout(w_pad=3, rect=(0, 0, 1, 0.84))
    fig.text(0.01, 0.97, "Accuracy against held-out CFD", fontsize=15, fontweight=700, va="top")
    fig.text(0.01, 0.895, "Highlighted: the LGO models (this project). Gray: the same networks without the local branch.",
             fontsize=10, color=t["ink2"], va="top")
    save(fig, "accuracy_velocity_r2", theme)


def speed(t, theme):
    """Time for one layout: the CFD solve against the model."""
    fig, ax = plt.subplots(figsize=(9.2, 2.6))
    bars = [("CFD solve (OpenFOAM, 8 cores)", 24.0, t["context"], "24 min median"),
            ("AeroTwin, whole room (565k points)", 20 / 60, t["accent"], "10–20 s"),
            ("AeroTwin, one comfort plane", 1 / 60, t["accent"], "< 1 s")]
    y = np.arange(len(bars))[::-1]
    for yi, (name, minutes, color, label) in zip(y, bars):
        ax.barh(yi, max(minutes, 0.12), height=0.58, color=color, zorder=2)
        ax.text(max(minutes, 0.12) + 0.35, yi, label, va="center", fontsize=11, fontweight=600, color=t["ink"])
    ax.set_yticks(y, [b[0] for b in bars], fontsize=10.5)
    ax.set_xlim(0, 28)
    ax.set_xticks([0, 5, 10, 15, 20, 25])
    ax.set_xlabel("Minutes per vent layout", fontsize=9.5)
    ax.grid(axis="x", color=t["grid"], lw=0.8, zorder=0)
    ax.tick_params(length=0)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.set_title("One layout, minutes versus seconds\n", loc="left", fontsize=15, fontweight=700)
    ax.text(0, 1.04, "Model times on one RTX A5000 GPU, after the layout is loaded (handoff timing).",
            transform=ax.transAxes, fontsize=9.5, color=t["ink2"])
    fig.tight_layout()
    save(fig, "speed_cfd_vs_model", theme)


def plan(ax, d, t, labels=False):
    """Room outline, furniture and the best layout's vents on a top-down plan."""
    w, h, _ = d["room"]
    for name, x0, y0, x1, y1, z0, z1 in d["furniture"]:
        if name == "Door":
            ax.plot([x0, x1], [0, 0], color=t["ink2"], lw=3, solid_capstyle="butt", zorder=4)
            if labels:
                ax.text((x0 + x1) / 2, -0.22, "Door", ha="center", va="top", fontsize=8.5, color=t["ink2"])
            continue
        ax.add_patch(Rectangle((x0, y0), max(x1 - x0, 0.04), max(y1 - y0, 0.04), fc=t["furniture"] if labels else "none",
                               ec=t["edge"], lw=0.9, zorder=3))
        if labels and name not in ("Table", "Column", "Board", "Wall_AC"):
            nice = {"Cabinet_01": "Cabinet", "Cabinet_02": "Cabinet", "Wall_AC": "Wall AC unit",
                    "Board": "Whiteboard", "TV": "TV", "Sink": "Sink", "Column": "Column"}[name]
            ax.text((x0 + x1) / 2 if name not in ("TV", "Cabinet_01", "Cabinet_02") else x0 - 0.08,
                    (y0 + y1) / 2 if name not in ("Board", "Wall_AC") else y1 + 0.12, nice,
                    ha="right" if name in ("TV", "Cabinet_01", "Cabinet_02") else "center",
                    va="center" if name not in ("Board", "Wall_AC") else "bottom", fontsize=8.5, color=t["ink2"], zorder=6)
    for (x, y), color in [(p, CYAN) for p in d["supply"]] + [(p, AMBER) for p in d["ret"]]:
        s = 0.59
        ax.add_patch(Rectangle((x - s / 2, y - s / 2), s, s, fc="none", ec=color, lw=1.8, zorder=5))
    ax.add_patch(Rectangle((0, 0), w, h, fc="none", ec=t["ink2"], lw=1.4, zorder=4))
    ax.set_xlim(-0.3, w + 0.3)
    ax.set_ylim(-0.45, h + 0.3)
    ax.set_aspect("equal")
    ax.axis("off")


def room_plan(d, t, theme):
    fig, ax = plt.subplots(figsize=(8, 6))
    plan(ax, d, t, labels=True)
    w, h, z = d["room"]
    tables = [f for f in d["furniture"] if f[0] == "Table"]
    big = max(tables, key=lambda f: (f[3] - f[1]) * (f[4] - f[2]))
    ax.text((big[1] + big[3]) / 2, (big[2] + big[4]) / 2, "Meeting table", ha="center", va="center", fontsize=9, color=t["ink2"], zorder=6)
    sx, sy = d["supply"].mean(0)
    rx, ry = d["ret"].mean(0)
    ax.text(d["supply"][:, 0].max() + 0.45, sy + 0.55, "3 supply vents · 13 °C in", ha="left", va="center",
            fontsize=9.5, color=CYAN, fontweight=600, zorder=6)
    ax.text(3.6, -0.22, "Whiteboard + wall AC unit", ha="center", va="top", fontsize=8.5, color=t["ink2"])
    ax.text(rx, ry - 0.55, "3 return vents · air out", ha="center", va="top", fontsize=9.5, color=AMBER, fontweight=600, zorder=6)
    ax.annotate("", (0, h + 0.18), (w, h + 0.18), arrowprops=dict(arrowstyle="<->", color=t["ink2"], lw=0.9))
    ax.text(w / 2, h + 0.24, f"{w:.1f} m", ha="center", va="bottom", fontsize=9.5, color=t["ink"])
    ax.annotate("", (w + 0.18, 0), (w + 0.18, h), arrowprops=dict(arrowstyle="<->", color=t["ink2"], lw=0.9))
    ax.text(w + 0.26, h / 2, f"{h:.1f} m", rotation=90, va="center", fontsize=9.5, color=t["ink"])
    ax.set_xlim(-0.4, w + 0.6)
    ax.set_ylim(-0.6, h + 0.6)
    ax.set_title(f"The room: {w:.1f} × {h:.1f} × {z:.1f} m office, best vent layout {d['case']}", loc="left",
                 fontsize=13, fontweight=700)
    save(fig, "room_plan", theme)


def field_map(d, t, theme, kind):
    fig, ax = plt.subplots(figsize=(8, 6.2))
    X, Y = d["x"], d["y"]
    step = X[1] - X[0]
    extent = [X[0] - step / 2, X[-1] + step / 2, Y[0] - step / 2, Y[-1] + step / 2]
    if kind == "speed":
        cmap = LinearSegmentedColormap.from_list("cyan", [t["bg"], "#0e4a5c", CYAN, "#e6fbff"] if theme == "dark"
                                                 else ["#f2fbfd", "#9be7f4", "#0891b2", "#073f4d"])
        img = ax.imshow(d["speed"].T, origin="lower", extent=extent, cmap=cmap, vmin=0, vmax=0.4,
                        interpolation="bicubic", zorder=1)
        bar = fig.colorbar(img, ax=ax, orientation="horizontal", fraction=0.045, pad=0.03, extend="max")
        bar.set_label("Air speed at 1.1 m, m/s", color=t["ink2"])
        title = "Where the air moves: predicted air speed at seated height"
        name = "map_air_speed"
    elif kind == "temp":
        cmap = LinearSegmentedColormap.from_list("amber", ["#1e3a8a", "#38bdf8", "#e2e8f0", AMBER])
        lo, hi = np.floor(np.percentile(d["temp"], 1) * 2) / 2, np.ceil(np.percentile(d["temp"], 99) * 2) / 2
        img = ax.imshow(d["temp"].T, origin="lower", extent=extent, cmap=cmap, vmin=lo, vmax=hi,
                        interpolation="bicubic", zorder=1)
        bar = fig.colorbar(img, ax=ax, orientation="horizontal", fraction=0.045, pad=0.03)
        bar.set_label("Air temperature at 1.1 m, °C", color=t["ink2"])
        title = "Predicted air temperature at seated height"
        name = "map_temperature"
    else:
        cls = np.where(d["speed"] > 0.25, 2, np.where(d["speed"] < 0.10, 0, 1))
        ax.imshow(cls.T, origin="lower", extent=extent, cmap=ListedColormap([STILL, GOOD, COOL]), vmin=-0.5,
                  vmax=2.5, interpolation="nearest", alpha=0.9, zorder=1)
        share = [100 * np.mean(cls == k) for k in range(3)]
        handles = [Rectangle((0, 0), 1, 1, color=c) for c in (GOOD, COOL, STILL)]
        ax.legend(handles, [f"Comfortable, 0.10–0.25 m/s  ({share[1]:.0f}%)", f"Drafty, over 0.25 m/s  ({share[2]:.0f}%)",
                            f"Still air, under 0.10 m/s  ({share[0]:.0f}%)"], loc="upper center",
                  bbox_to_anchor=(0.5, -0.02), ncol=1, frameon=False, fontsize=10, labelcolor=t["ink"])
        title = "Comfort map at seated height (ASHRAE 55 speed bands)"
        name = "map_comfort"
    plan(ax, d, t)
    if kind != "comfort":
        bar.outline.set_visible(False)
        bar.ax.tick_params(color=t["ink2"], labelcolor=t["ink2"], length=0)
    ax.set_title(f"{title}\n", loc="left", fontsize=13, fontweight=700)
    ax.text(0, 1.015, f"LGO-GINOT prediction for layout {d['case']}, 1.1 m above the floor. Cyan squares: supply vents, "
            "amber: returns.", transform=ax.transAxes, fontsize=9, color=t["ink2"])
    save(fig, name, theme)


def stats(t, theme):
    """The headline numbers as tiles; every figure is from the handoff results."""
    tiles = [("0.978", "velocity R²", "on layouts near the training set"),
             ("0.14 °C", "temperature error", "mean absolute, held-out CFD"),
             ("≤ 20 s", "per layout, whole room", "vs a 24 min median CFD solve"),
             ("46", "layouts ranked", "by comfort score, in the app")]
    fig, axes = plt.subplots(1, 4, figsize=(12, 2.4))
    for ax, (big, label, note) in zip(axes, tiles):
        ax.axis("off")
        ax.text(0, 0.62, big, fontsize=30 if len(big) < 8 else 22, fontweight=700,
                color=t["accent"], transform=ax.transAxes)
        ax.text(0, 0.34, label, fontsize=13, fontweight=600, color=t["ink"], transform=ax.transAxes)
        ax.text(0, 0.14, note, fontsize=9.5, color=t["ink2"], transform=ax.transAxes)
    save(fig, "stat_tiles", theme)


def main():
    d = twin()
    for theme, t in THEMES.items():
        style(t)
        accuracy(t, theme)
        speed(t, theme)
        room_plan(d, t, theme)
        for kind in ("speed", "temp", "comfort"):
            field_map(d, t, theme, kind)
        stats(t, theme)
    print(sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
