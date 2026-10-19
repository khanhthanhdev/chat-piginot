# AeroTwin intro

A 3840x2160 (4K) @ 60 fps video, laid out on a 1920x1080 canvas drawn at twice the size, made with [fframes](https://github.com/dmtrKovalenko/fframes),
rendered on the GPU with the Skia (Vulkan) backend.

fframes comes from its git repository at a pinned revision (the same one in the dependency and
`[patch.crates-io]`). macOS encodes H.264. On Linux the prebuilt ffmpeg's x264 (ABI 163) does
not match Ubuntu 24.04's libx264 (164), so `render` writes MPEG-4 Part 2; transcode the final
file with the system ffmpeg. That intermediate is kept near lossless (quantizer 1-3):
`ffmpeg -i out.mp4 -c:v libx264 -crf 16 -preset medium -tune animation -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -c:a copy -movflags +faststart aerotwin-intro-4k60.mp4`.

The room, vent layouts, air paths, comfort maps, probe readings and optimizer scores are real
model output, generated into `src/twin.rs` by `tools/twin_data.py` from the LGO handoff's
test cases with the `final30_lgo_ginot_lr1e-3` model, through the app backend's
`InferenceEngine` (the same ranking `POST /cases/optimize` returns).

| file | what |
| --- | --- |
| `src/lib.rs` | the video: scenes, animation, audio map |
| `src/main.rs` | the command line (`fframes::cli`) |
| `src/twin.rs` | generated: room, layouts, predicted planes and streamlines |
| `tools/twin_data.py` | regenerates `src/twin.rs` from the handoff (needs its `.venv` and a GPU) |
| `src/bin/synth_audio.rs` | synthesizes the score and sound effects into `media/` |
| `media/` | fonts and the synthesized audio, embedded into the binary |

## Work on it

```sh
cargo run --release -- timeline                      # scenes, duration, audio tracks
cargo run --release -- preview 0s                    # real-time GPU window with sound (space, h/l, j/k, q)
cargo run --release -- frame 1s,50%,end              # PNGs into frames/ and the problems found in them
cargo run --release -- strip Workflow -n 8         # contact sheet, writes strip.png
cargo run --release -- onion "Product@0..Product@1.5s"  # motion trail of an entrance, writes onion.png
cargo run --release -- inspect                       # missing media/fonts, clipped text, panics in any frame
cargo run --release -- render Workflow --draft     # a part of the video, half resolution, fast preset
cargo run --release -- audio analyze --waveform w.png  # loudness (LUFS), peaks, silence per scene
cargo run --release -- render                        # the final video, writes out.mp4
cargo run --release --bin synth_audio                # regenerate media/*.wav after timing changes, then rebuild
LGO_HANDOFF=~/code/lgo-digital-twin-handoff $LGO_HANDOFF/.venv/bin/python -I tools/twin_data.py  # refresh src/twin.rs
```

If bindgen fails in `ffmpeg-sys-fframes` with `'limits.h' file not found`, install `libclang-dev`
or point it at GCC's headers: `BINDGEN_EXTRA_CLANG_ARGS=-I/usr/lib/gcc/x86_64-linux-gnu/13/include`.

Times accept frames (`120`), seconds (`3.2s`), `m:ss`, percentages (`50%`), scenes (`Workflow`,
`#1`) and offsets inside scenes (`Workflow@1.5s`, `@50%`, `@end`). Add `--json` to any
command for machine-readable output.
