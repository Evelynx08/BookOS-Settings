#!/usr/bin/env python3
"""BookOS — battery runtime predictor.

Reads current state from CLI args (or stdin JSON) and returns a JSON
prediction of minutes remaining until 20% charge.

Usage:
    predict.py --nivel 65 --power_w 8.2 --hora 14 --dia 3 --t_min 870
    echo '{"nivel":65,"power_w":8.2,"hora":14,"dia":3,"t_min":870}' | predict.py -
"""

import argparse
import json
import os
import sys
from pathlib import Path

import joblib

MODEL_PATH = Path(os.environ.get("BOOKOS_MODEL_DIR", "/var/lib/bookos-ai")) / "model.pkl"


def load_input() -> dict:
    if len(sys.argv) > 1 and sys.argv[1] == "-":
        return json.loads(sys.stdin.read())
    p = argparse.ArgumentParser()
    p.add_argument("--nivel", type=float, required=True)
    p.add_argument("--power_w", type=float, required=True)
    p.add_argument("--hora", type=int, required=True)
    p.add_argument("--dia", type=int, required=True)
    p.add_argument("--t_min", type=int, required=True)
    a = p.parse_args()
    return vars(a)


def main() -> int:
    if not MODEL_PATH.exists():
        print(json.dumps({"ok": False, "reason": "model_not_trained"}))
        return 0
    bundle = joblib.load(MODEL_PATH)
    model = bundle["model"]
    features = bundle["features"]
    target_level = bundle.get("target_level", 20)

    inp = load_input()
    if inp.get("nivel", 0) <= target_level:
        print(json.dumps({"ok": True, "minutes": 0, "target_level": target_level, "note": "below_target"}))
        return 0

    row = [[float(inp[f]) for f in features]]
    pred = float(model.predict(row)[0])
    pred = max(0.0, min(720.0, pred))
    print(json.dumps({
        "ok": True,
        "minutes": round(pred, 1),
        "target_level": target_level,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
