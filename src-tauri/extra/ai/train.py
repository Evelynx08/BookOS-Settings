#!/usr/bin/env python3
"""BookOS — battery runtime trainer.

Reads /var/log/bookos/battery.csv and produces an XGBoost model that
predicts minutes remaining until 20% charge. Sessions are segmented
properly: any gap larger than 5 minutes between samples, or a state
change (charging <-> discharging), starts a new session.

Outputs: /var/lib/bookos-ai/model.pkl  (joblib bundle of model + meta)
"""

import json
import os
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split
from xgboost import XGBRegressor

CSV_PATH   = os.environ.get("BOOKOS_BATTERY_CSV", "/var/log/bookos/battery.csv")
MODEL_DIR  = Path(os.environ.get("BOOKOS_MODEL_DIR", "/var/lib/bookos-ai"))
MODEL_PATH = MODEL_DIR / "model.pkl"
TARGET_LEVEL = 20    # minutes remaining until this percentage
SESSION_GAP_MIN = 5  # gap that splits sessions
MIN_SAMPLES = 30     # bail out if too little data


def load_csv(path: str) -> pd.DataFrame:
    """Load battery CSV. Tolerates rows with 5 or 6 columns (older logger
    versions didn't emit power_uw). Skips bad rows silently."""
    columns = ["dia", "hora", "minuto", "nivel", "estado", "power_uw"]
    df = pd.read_csv(
        path,
        header=None,
        names=columns,
        skiprows=1,             # drop the original header row whatever shape it has
        on_bad_lines="skip",
        engine="python",
    )
    for col in ("dia", "hora", "minuto", "nivel", "power_uw"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["estado"] = df["estado"].astype(str).str.strip().str.lower()
    df = df.dropna(subset=["dia", "hora", "minuto", "nivel"])
    df["power_w"] = df["power_uw"].fillna(0) / 1e6
    df["t_min"] = df["hora"] * 60 + df["minuto"]
    return df.reset_index(drop=True)


def build_sessions(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    # Gap between consecutive rows in minutes (modulo day boundary)
    delta_min = df["t_min"].diff().fillna(0)
    delta_day = df["dia"].diff().fillna(0)
    new_session = (
        (delta_day != 0)
        | (delta_min.abs() > SESSION_GAP_MIN)
        | (df["estado"] != df["estado"].shift())
    )
    df["session"] = new_session.cumsum().astype(int)
    return df


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """For each discharging row, compute minutes remaining until TARGET_LEVEL
    within the same session. Drop rows that never reach TARGET_LEVEL."""
    out_rows = []
    for _, sess in df[df["estado"] == "discharging"].groupby("session"):
        sess = sess.sort_values("t_min").reset_index(drop=True)
        if len(sess) < 5:
            continue
        # Find the first index where level <= TARGET_LEVEL
        below = sess[sess["nivel"] <= TARGET_LEVEL]
        if below.empty:
            continue  # session never reached the target — can't supervise
        target_t = below.iloc[0]["t_min"]
        for _, row in sess.iterrows():
            if row["nivel"] <= TARGET_LEVEL:
                break
            minutes_left = target_t - row["t_min"]
            if minutes_left <= 0 or minutes_left > 720:
                continue
            out_rows.append({
                "nivel": row["nivel"],
                "power_w": row["power_w"],
                "hora": row["hora"],
                "dia": row["dia"],
                "t_min": row["t_min"],
                "y": minutes_left,
            })
    return pd.DataFrame(out_rows)


def main() -> int:
    if not Path(CSV_PATH).exists():
        print(f"error: {CSV_PATH} not found", file=sys.stderr)
        return 1

    df = load_csv(CSV_PATH)
    df = build_sessions(df)
    feats = build_features(df)
    if len(feats) < MIN_SAMPLES:
        meta = {"ok": False, "reason": "insufficient_data", "rows": int(len(feats)), "needed": MIN_SAMPLES}
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        (MODEL_DIR / "meta.json").write_text(json.dumps(meta))
        print(json.dumps(meta))
        return 0  # not a failure — just need more samples

    feature_cols = ["nivel", "power_w", "hora", "dia", "t_min"]
    X = feats[feature_cols]
    y = feats["y"]

    # Time-aware split (use last 20% as test) so we don't leak future into training
    cut = int(len(feats) * 0.8)
    X_train, X_test = X.iloc[:cut], X.iloc[cut:]
    y_train, y_test = y.iloc[:cut], y.iloc[cut:]
    if len(X_test) < 5:
        # Random fallback
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = XGBRegressor(
        n_estimators=400,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        objective="reg:absoluteerror",
        tree_method="hist",
        n_jobs=2,
    )
    model.fit(X_train, y_train, verbose=False)

    mae = float(mean_absolute_error(y_test, model.predict(X_test)))

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump({
        "model": model,
        "features": feature_cols,
        "target_level": TARGET_LEVEL,
        "trained_rows": int(len(feats)),
    }, MODEL_PATH)

    meta = {
        "ok": True,
        "mae_minutes": mae,
        "trained_rows": int(len(feats)),
        "target_level": TARGET_LEVEL,
    }
    (MODEL_DIR / "meta.json").write_text(json.dumps(meta))
    print(json.dumps(meta))
    return 0


if __name__ == "__main__":
    sys.exit(main())
