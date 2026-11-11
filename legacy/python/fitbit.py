"""
Put a Fitbit export next to the per-second data.

Expects a file fitbit.json in the session folder (or another .json/.md/.txt that contains the
export JSON with a "fitbit" block; text before the first "{" is ignored).
Used: sleep stages, vitals, heart rate/min, SpO2/min, HRV/5 min and, if
present, room climate (tado).
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

TZ = "Europe/Berlin"
LOW_SPO2 = 90
LOW_SPO2_MIN_MINUTES = 5
ODI_DROP = 3                 # desaturation: ≥3 points below the median of the previous 5 min
POSE_STILL_DEG = 10          # arm pose counts as unchanged while it tilts less than this
STAGE_ORDER = ["wake", "rem", "light", "deep"]


def find_export(session: Path, explicit: Path | None = None):
    candidates = [explicit] if explicit else \
        [session / "fitbit.json"] + sorted(p for p in session.iterdir()
                                           if p.suffix.lower() in (".json", ".md", ".txt"))
    for p in candidates:
        if p is None or not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        if "{" not in text:
            continue
        try:
            data = json.loads(text[text.index("{"):])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "fitbit" in data:
            return data, p
    return None, None


def session_zone(session):
    meta = Path(session) / "session.json"
    return json.loads(meta.read_text(encoding="utf-8")).get("timeZone", TZ) if meta.exists() else TZ


def _local(series, zone):
    def parse(value):
        stamp = pd.to_datetime(value, errors="coerce")
        if pd.isna(stamp):
            return pd.NaT
        if stamp.tzinfo is None:
            stamp = stamp.tz_localize(zone, ambiguous="NaT", nonexistent="NaT")
        return stamp
    return pd.to_datetime(series.map(parse), utc=True).dt.tz_convert(zone)


def load(data: dict, zone=TZ):
    fb = data["fitbit"]
    out = {"vitals": fb.get("vitals") or {}, "sleep": fb.get("sleep") or {}}
    tl = pd.DataFrame(out["sleep"].get("timeline") or [])
    if not tl.empty:
        tl["start"] = _local(tl.start, zone)
        tl["end"] = tl.start + pd.to_timedelta(tl.minutes, unit="min")
    out["stages"] = tl
    for key, src, col in (("hr", "heartRatePerMinute", "bpm"), ("spo2", "spo2PerMinute", "value"),
                          ("hrv", "hrvPer5Minutes", "value")):
        df = pd.DataFrame(fb.get(src) or [])
        out[key] = (df.assign(t=_local(df.time, zone).dt.tz_convert("UTC").dt.floor("min")).dropna(subset=["t"])
                    .set_index("t")[col].groupby(level=0).mean()) if not df.empty else pd.Series(dtype=float)
    room = pd.DataFrame((data.get("tado") or {}).get("readings") or [])
    out["room"] = room
    return out


def stage_at(stages: pd.DataFrame, times):
    times = pd.DatetimeIndex(times)
    out = np.full(len(times), None, dtype=object)
    for _, r in stages.iterrows():
        out[(times >= r.start) & (times < r.end)] = r.level
    return out


def wrist_pose(acc: pd.DataFrame, zone=TZ):
    """Gravity direction per minute (unit vector) and angle change to the previous minute."""
    t = pd.to_datetime(acc.epoch_ms, unit="ms", utc=True).dt.tz_convert(zone)
    g = acc.set_index(t)[["x", "y", "z"]].resample("1min").median()
    g = g.div(np.linalg.norm(g.values, axis=1), axis=0)
    prev = g.shift()
    cos = (g * prev).sum(axis=1, min_count=3).clip(-1, 1)   # first minute: no previous value -> NaN instead of 90°
    g["pose_change_deg"] = np.degrees(np.arccos(cos))
    return g


def annotate(minutes: pd.DataFrame, fb: dict, pose: pd.DataFrame):
    m = minutes.copy()
    if not fb["stages"].empty:
        m["stage"] = stage_at(fb["stages"], m.index)
    m["fitbit_hr"] = fb["hr"].reindex(m.index)
    m["spo2"] = fb["spo2"].reindex(m.index)
    m["hrv"] = fb["hrv"].reindex(m.index, method="ffill", limit=4) if len(fb["hrv"]) else np.nan
    m = m.join(pose, how="left")
    return m


def low_spo2_episodes(m: pd.DataFrame, events: pd.DataFrame):
    """
    Minutes with SpO2 < LOW_SPO2; gaps up to 3 min (missing or just above) are bridged.
    Per episode: duration, minimum, how much the arm pose changed meanwhile,
    whether it ended with a movement and whether the heart rate reacted.
    """
    low_t = m.spo2[m.spo2 < LOW_SPO2].index
    rows, cur = [], []
    for t in low_t:
        if cur and (t - cur[-1]) > pd.Timedelta("3min"):
            rows.append(cur); cur = []
        cur.append(t)
    rows.append(cur)
    rows = [ep for ep in rows if len(ep) >= LOW_SPO2_MIN_MINUTES]

    mv_t = pd.to_datetime(events.start_ms, unit="ms", utc=True).dt.tz_convert(TZ) \
        if not events.empty else pd.Series(dtype="datetime64[ns, Europe/Berlin]")
    out = []
    for ep in rows:
        a, b = ep[0], ep[-1] + pd.Timedelta("1min")
        steps = pd.Series(ep).diff()
        longest = int(steps.ne(pd.Timedelta("1min")).cumsum().value_counts().max())
        pattern = "sustained" if len(ep) == longest else "intermittent"
        seg = m.loc[a:b - pd.Timedelta("1min")]
        core = seg.iloc[:-2] if len(seg) > 4 else seg   # without the final movement
        pose_change = core.pose_change_deg.iloc[1:].max() if len(core) > 1 else 0.0
        ends_with_move = bool(((mv_t >= b - pd.Timedelta("3min")) & (mv_t <= b + pd.Timedelta("2min"))).any())
        hr_rise = (core.hr_max.max() - core.hr_mean.median()) if "hr_max" in core else np.nan
        still = (pose_change or 0) < POSE_STILL_DEG
        verdict = "insufficient HR data" if not np.isfinite(hr_rise) else "unclear"
        if still and ends_with_move and np.isfinite(hr_rise) and hr_rise < 10:
            verdict = "probably a pose artifact (arm still, ends with movement, heart rate calm)"
        out.append({"start": a, "end": b, "minutes": len(ep), "spo2_min": seg.spo2.min(),
                    "spo2_mean": seg.spo2.mean(), "max_pose_change_deg": pose_change,
                    "ends_with_movement": ends_with_move, "hr_rise_bpm": hr_rise,
                    "stage": seg.stage.mode().iloc[0] if "stage" in seg and seg.stage.notna().any() else None,
                    "verdict": verdict, "pattern": pattern, "longest_run_minutes": longest})
    return pd.DataFrame(out)


def odi(m: pd.DataFrame):
    s = m.spo2.dropna()
    if len(s) < 10:
        return 0, np.nan
    base = s.rolling("5min", closed="left").median()
    drops = (s <= base - ODI_DROP)
    # consecutive minutes count as one desaturation
    n = int((drops & ~drops.shift(fill_value=False)).sum())
    return n, n / (len(s) / 60)


def summary_lines(fb, m, breath, events, min_quality):
    lines = ["", "— Comparison with Fitbit —"]
    v, sl = fb["vitals"], fb["sleep"]
    if sl:
        lines.append(f"Sleep per Fitbit: {sl.get('minutesAsleep')} min, efficiency {sl.get('efficiency')} %, "
                     f"deep {sl.get('deepMinutes')} / light {sl.get('lightMinutes')} / "
                     f"REM {sl.get('remMinutes')} / awake {sl.get('wakeMinutes')} min")

    if not breath.empty and not fb["stages"].empty:
        b = breath[breath.quality >= min_quality].copy()
        b["stage"] = stage_at(fb["stages"], pd.to_datetime(b.epoch_ms, unit="ms", utc=True).dt.tz_convert(TZ))
        ref = {"deep": v.get("breathingDeep"), "light": v.get("breathingLight"), "rem": v.get("breathingRem")}
        parts = []
        for st in ("deep", "light", "rem"):
            s = b[b.stage == st].breaths_per_min
            if len(s):
                parts.append(f"{st} {s.median():.1f} ±{s.std():.1f} (Fitbit {ref[st] if ref[st] is not None else '–'})")
        lines.append(f"Watch breathing rate per stage: " + ", ".join(parts) +
                     f"; overall Fitbit {v.get('breathingRate', '–')}")

    both = m[["hr_mean", "fitbit_hr"]].dropna() if "hr_mean" in m else pd.DataFrame()
    if len(both) > 30:
        lines.append(f"Heart rate watch vs. Fitbit: r = {both.corr().iloc[0, 1]:.3f}, "
                     f"mean difference {(both.hr_mean - both.fitbit_hr).mean():+.1f} bpm")

    if "stage" in m and not events.empty:
        st_min = m.stage.value_counts()
        ev_st = m.loc[m.movement_events > 0].groupby("stage").movement_events.sum()
        lines.append("Movement per stage: " + ", ".join(
            f"{s} {ev_st.get(s, 0) / st_min[s] * 60:.1f}/h" for s in STAGE_ORDER if s in st_min))

    if m.spo2.notna().any():
        n_odi, odi_h = odi(m)
        lines.append(f"SpO2: mean {m.spo2.mean():.1f} %, min {m.spo2.min():.1f} %, "
                     f"{(m.spo2 < LOW_SPO2).sum()} min below {LOW_SPO2} %, "
                     f"desaturations ≥{ODI_DROP} points: {n_odi} ({odi_h:.1f}/h)")
        if v.get("hrv") is not None:
            lines.append(f"HRV (Fitbit): {v.get('hrv')} ms, resting HR {v.get('restingHeartRate')}")
    room = fb["room"]
    if not room.empty:
        hum = room.humidity.mean()
        lines.append(f"Room: {room.temperature.mean():.1f} °C, {hum:.0f} % humidity"
                     + (" (above 60 %)" if hum > 60 else ""))
    return lines


def plot_extra(ax_stage, ax_spo2, fb, m, episodes):
    st = fb["stages"]
    if not st.empty:
        y = {s: i for i, s in enumerate(STAGE_ORDER)}
        for _, r in st.iterrows():
            ax_stage.hlines(y.get(r.level, 0), r.start, r.end, lw=6,
                            color={"wake": "tab:red", "rem": "tab:purple", "light": "tab:cyan",
                                   "deep": "tab:blue"}.get(r.level, "grey"))
        ax_stage.set_yticks(range(len(STAGE_ORDER)), STAGE_ORDER)
        ax_stage.invert_yaxis()
        ax_stage.set_ylabel("Stage (Fitbit)")
    if m.spo2.notna().any():
        ax_spo2.plot(m.index, m.spo2, ".", ms=3)
        ax_spo2.axhline(LOW_SPO2, color="tab:red", lw=0.8, ls="--")
        for _, e in episodes.iterrows():
            ax_spo2.axvspan(e.start, e.end, color="tab:orange" if "artifact" in e.verdict else "tab:red",
                            alpha=0.25)
        ax_spo2.set_ylabel("SpO2 %")
