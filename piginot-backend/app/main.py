from __future__ import annotations

import sys
from pathlib import Path
from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_ROOT / ".env")

LGO_SOURCE = BACKEND_ROOT / "lgo"
sys.path.insert(0, str(LGO_SOURCE))

from serve.app import app

__all__ = ["app"]
