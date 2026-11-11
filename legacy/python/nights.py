"""
Multi-night overview: reads several session folders already analysed with analyze.py
(per_minute.csv, breathing.csv, movement_events.csv, events.csv, optionally fitbit.json)
and writes one table row per night.

Optional note per night: notes.txt in the session folder with key=value lines, e.g.
    mouth_tape=yes
    note=toilet 04:00

Usage:
    python nights.py ../sessions/20261030_224900 ../sessions/20261031_235707 ... [--out nights.csv]
    python nights.py ../sessions/*            (all folders with per_minute.csv)
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

import fitbit as F

MIN_QUALITY = 0.4


def read_notes(session: Path):
    p = session / "notes.txt"
    if not p.exists():
        return {}
    out = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def battery_rate(session: Path):
    ev = pd.read_csv(session / "events.csv")
    b = ev[ev.event.str.startswith("battery")]
    if len(b) < 2:
        return np.nan
    pct = b.event.str.split().str[1].astype(float)
    h = (b.epoch_ms.iloc[-1] - b.epoch_ms.iloc[0]) / 3.6e6
    return (pct.iloc[0] - pct.iloc[-1]) / h


def night_row(session: Path):
    zone = F.session_zone(session)
    m = pd.read_csv(session / "per_minute.csv", parse_dates=["minute"]).set_index("minute")
    m.index = pd.to_datetime(m.index, utc=True).tz_convert(zone)
    br = pd.read_csv(session / "breathing.csv")
    br = br[br.quality >= MIN_QUALITY].copy()
    br["t"] = pd.to_datetime(br.epoch_ms, unit="ms", utc=True).dt.tz_convert(zone)
    mv = pd.read_csv(session / "movement_events.csv")
    hours = len(m) / 60

    r = {"night": session.name, "start": m.index[0].strftime("%Y-%m-%d %H:%M"),
         "duration_h": round(hours, 1)}
    r.update(read_notes(session))

    data, _ = F.find_export(session)
    asleep = m
    if data:
        fb = F.load(data, zone)
        sl, v = fb["sleep"], fb["vitals"]
        day = data["fitbit"].get("dayBefore") or {}
        r.update({"sleep_min": sl.get("minutesAsleep"), "efficiency": sl.get("efficiency"),
                  "deep_min": sl.get("deepMinutes"), "rem_min": sl.get("remMinutes"),
                  "wake_min": sl.get("wakeMinutes"), "hrv_ms": v.get("hrv"),
                  "resting_hr_fitbit": v.get("restingHeartRate"),
                  "breathing_fitbit": v.get("breathingRate"), "steps_day_before": day.get("steps")})
        if not fb["stages"].empty:
            stage = F.stage_at(fb["stages"], m.index)
            asleep = m[pd.Series(stage, index=m.index).isin(["light", "deep", "rem"])]
            br["stage"] = F.stage_at(fb["stages"], br.t)
            for st in ("deep", "light", "rem"):
                s = br[br.stage == st].breaths_per_min
                r[f"breathing_{st}"] = round(s.median(), 1) if len(s) else np.nan
            deep_min = m[pd.Series(stage, index=m.index) == "deep"]
            r["hr_deep"] = round(deep_min.hr_mean.median(), 1) if len(deep_min) else np.nan
        room = fb["room"]
        if not room.empty:
            r["room_c"] = round(room.temperature.mean(), 1)
            r["room_rh"] = round(room.humidity.mean())
        if "spo2" in m:
            r["spo2_mean"] = round(m.spo2.mean(), 1)
            r["spo2_below90_min"] = int((m.spo2 < F.LOW_SPO2).sum())

    r.update({"hr_asleep_median": round(asleep.hr_mean.median(), 1),
              "hr_min": int(m.hr_min.min()),
              "breathing_median": round(br.breaths_per_min.median(), 1),
              "breathing_std": round(br.breaths_per_min.std(), 2),
              "movements_per_h": round(len(mv) / hours, 1),
              "posture_changes": int((mv.orientation_change_deg > 30).sum()),
              "cvhr_episodes": len(pd.read_csv(session / "cvhr_episodes.csv"))
              if (session / "cvhr_episodes.csv").stat().st_size > 1 else 0,
              "battery_pct_per_h": round(battery_rate(session), 1)})
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sessions", type=Path, nargs="+")
    ap.add_argument("--out", type=Path, default=Path("nights.csv"))
    args = ap.parse_args()
    rows = [night_row(s) for s in sorted(args.sessions) if (s / "per_minute.csv").exists()]
    if not rows:
        raise SystemExit("No analysed sessions found (run analyze.py first).")
    df = pd.DataFrame(rows).set_index("night")
    df.to_csv(args.out)
    with pd.option_context("display.max_columns", None, "display.width", 200):
        print(df.T.to_string())
    print(f"\nTable: {args.out}")


if __name__ == "__main__":
    main()
