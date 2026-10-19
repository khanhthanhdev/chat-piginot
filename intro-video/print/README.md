# AeroTwin print assets: A4 flyer and standee

Everything here is real output, not mock-up: the 3D visuals are frames of the intro video re-drawn
at print resolution (`aerotwin-intro frame --crop --zoom`), and the charts come from
`tools/print_assets.py`. Both read the LGO-GINOT model's predictions for the best layout, D006
(`src/twin.rs`), and the handoff's test results (`results/summary.csv`).

Print sizes assume 300 dpi for the flyer and 150 dpi for the standee (viewed from 1–2 m).

## Visuals (`visuals/`, dark background `#0c0e11`)

| file | px | flyer at 300 dpi | standee at 150 dpi | use |
|---|---|---|---|---|
| `01_hero_airflow_3d.png` | 4875×3650 | 41 cm wide | 82 cm wide | **hero image**: real air paths through the room, cold supply (blue) warming to 20 °C (amber) |
| `02_comfort_map_3d.png` | 4750×3600 | 40 cm | 80 cm | where people will be comfortable / drafty / in still air |
| `03_live_probe.png` | 5300×3650 | 45 cm | 88 cm | "point anywhere, get a reading": 18.1 °C, 0.29 m/s, drafty |
| `04_compare_layouts.png` | 6400×2080 | 54 cm | 107 cm | four real layouts ranked by comfort score; D006 best at 75.2 |
| `05_app_optimizer_screenshot.png` | 5680×3200 | 48 cm | 95 cm | the app: workflow steps, scores, airflow |
| `06_model_pipeline.png` | 6320×2000 | 53 cm | 105 cm | how it works: boundary points → LGO operator → air + temperature |
| `07_wordmark_tagline.png` | 6880×2640 | 58 cm | 115 cm | AeroTwin wordmark with "Indoor airflow, from minutes to seconds." |

## Charts (`charts/`, each `_dark` and `_light`, PNG 300 dpi + vector PDF)

| file | shows |
|---|---|
| `accuracy_velocity_r2` | velocity R² of all 7 models + a lookup baseline, on both test sets; LGO highlighted |
| `speed_cfd_vs_model` | one layout: 24 min CFD vs 10–20 s whole room vs < 1 s comfort plane |
| `stat_tiles` | the four headline numbers below |
| `room_plan` | top-down plan of the room, furniture and D006's six vents, with dimensions |
| `map_air_speed` | predicted air speed at 1.1 m (top-down) |
| `map_temperature` | predicted air temperature at 1.1 m (top-down) |
| `map_comfort` | comfort bands at 1.1 m with shares: 56% comfortable, 5% drafty, 38% still |

Use the PDFs for the standee: they are vector and scale to any size. Dark charts sit next to the
dark visuals; the light ones suit a white flyer.

## Suggested layouts

**A4 flyer (210×297 mm):** wordmark + tagline at the top; `01_hero_airflow_3d` across the full
width; `stat_tiles` beneath; a "how it works" row with `06_model_pipeline`; then
`02_comfort_map_3d` and `04_compare_layouts` side by side; team names and a QR code to the demo
video at the bottom.

**Standee (e.g. 80×200 cm roll-up):** wordmark at eye level or above (top 40 cm); one large
claim ("24 minutes of CFD → seconds"); `01_hero_airflow_3d` large in the middle; three numbers
from `stat_tiles`; `03_live_probe` or `05_app_optimizer_screenshot`; `accuracy_velocity_r2` low
down for people who come close. Keep the bottom 20 cm free of text, since it is hidden behind
tables at a booth.

## Copy with sources

Every number is from the handoff (`HANDOFF.md`, `results/summary.csv`) or the model run in
`tools/twin_data.py`. Don't round them up further.

- **0.978 velocity R²**: LGO-GINOT on layouts near the training set (gap-0.30, 21 layouts).
  On layouts far from it (gap-0.58, 25 layouts) the best LGO model gets 0.942; without the
  local branch, the same networks drop to 0.27–0.64.
- **0.14 °C temperature error**: mean absolute error, LGO-GINOT, gap-0.30 (0.138 K). On the
  harder set: 0.24 °C.
- **24 min → 10–20 s**: the median CFD solve per layout, against a whole-room prediction
  (565,000 points) on one RTX A5000. A comfort plane takes under a second.
- **143 OpenFOAM simulations** trained the model; it is tested on **46 held-out layouts**.
- **One room**: 8.8 × 6.1 × 3.2 m office, 3 supply + 3 return ceiling vents, 13 °C supply air.

Do not claim it works for any building. The model covers this one room, and only vent positions
vary. At seated height the predicted air speed is a guide, not an exact value, while temperature
is accurate throughout (`HANDOFF.md`, "What the model can and cannot do").

Headline options: "See the air before you move the vents." · "24 minutes of CFD, now seconds."
· "Find the most comfortable vent layout in a minute."

## Regenerate

```sh
LGO_HANDOFF=~/code/lgo-digital-twin-handoff
$LGO_HANDOFF/.venv/bin/python -I tools/print_assets.py          # charts
./target/release/aerotwin-intro frame Product@8.2s --crop 680,600,1950,1460 --zoom 2.5 -o print/visuals
```
