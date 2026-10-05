"""python -m serve [--device auto|cpu|cuda] [--host 0.0.0.0] [--port 8000] [--preload CASE ...]

Run from `code/`. Settings not given as flags come from the LGO_* environment
variables listed in serve/app.py.
"""

import argparse
import os


def main():
    ap = argparse.ArgumentParser(prog="python -m serve", description="LGO inference service")
    ap.add_argument("--device", default=None, help="auto | cpu | cuda | cuda:N (default: $LGO_DEVICE or auto)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--models", default=None, help="models directory ($LGO_MODELS_DIR)")
    ap.add_argument("--cases", default=None, help="case roots, ':'-separated ($LGO_CASES_DIRS)")
    ap.add_argument("--max-cases", type=int, default=None, help="($LGO_MAX_CASES)")
    ap.add_argument("--threads", type=int, default=None,
                    help="torch CPU threads and KD-tree workers (LGO_KNN_WORKERS)")
    ap.add_argument("--preload", nargs="*", default=[],
                    help="cases to load with the default model before serving")
    args = ap.parse_args()

    for flag, var in ((args.device, "LGO_DEVICE"), (args.models, "LGO_MODELS_DIR"),
                      (args.cases, "LGO_CASES_DIRS"), (args.max_cases, "LGO_MAX_CASES")):
        if flag is not None:
            os.environ[var] = str(flag)
    if args.threads:
        os.environ["LGO_KNN_WORKERS"] = str(args.threads)

    import torch
    import uvicorn
    from serve import app as appmod

    if args.threads:
        torch.set_num_threads(args.threads)
    eng = appmod.engine()
    print(f"[serve] device {eng.device} | {len(eng.runs)} models | {len(eng.cases)} cases "
          f"| default model {appmod.DEFAULT_RUN}", flush=True)
    for case in args.preload:
        e = eng.get_case(appmod.DEFAULT_RUN, case)
        print(f"[serve] preloaded {case} in {e.setup_s:.1f} s", flush=True)
    # One process: the models and their caches live in it.
    uvicorn.run(appmod.app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
