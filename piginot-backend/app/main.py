from __future__ import annotations

import sys
from pathlib import Path

LGO_SOURCE = Path(__file__).resolve().parents[1] / "lgo"
sys.path.insert(0, str(LGO_SOURCE))

from serve.app import app

__all__ = ["app"]
