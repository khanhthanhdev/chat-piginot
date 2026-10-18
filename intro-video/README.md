# AeroTwin intro

A 1920x1080 @ 30 fps video made with [fframes](https://github.com/dmtrKovalenko/fframes),
rendered with the built-in CPU backend.

Requires a local fframes 1.3 checkout: `Cargo.toml` points at
`C:/Users/Administrator/fframes-desktop/fframes`; change that path (in both the dependency and
`[patch.crates-io]`) to build on another machine.

| file | what |
| --- | --- |
| `src/lib.rs` | the video: scenes, animation, audio map |
| `src/main.rs` | the command line (`fframes::cli`) |
| `src/bin/synth_audio.rs` | synthesizes the score and sound effects into `media/` |
| `media/` | fonts and the synthesized audio, embedded into the binary |

## Work on it

```sh
cargo run --release -- timeline                      # scenes, duration, audio tracks
cargo run --release -- frame 1s,50%,end              # PNGs into frames/ and the problems found in them
cargo run --release -- strip Workflow -n 8         # contact sheet, writes strip.png
cargo run --release -- onion "Product@0..Product@1.5s"  # motion trail of an entrance, writes onion.png
cargo run --release -- inspect                       # missing media/fonts, clipped text, panics in any frame
cargo run --release -- render Workflow --draft     # a part of the video, half resolution, fast preset
cargo run --release -- audio analyze --waveform w.png  # loudness (LUFS), peaks, silence per scene
cargo run --release -- render                        # the final video, writes out.mp4
cargo run --release --bin synth_audio                # regenerate media/*.wav after timing changes, then rebuild
```

Times accept frames (`120`), seconds (`3.2s`), `m:ss`, percentages (`50%`), scenes (`Workflow`,
`#1`) and offsets inside scenes (`Workflow@1.5s`, `@50%`, `@end`). Add `--json` to any
command for machine-readable output.
