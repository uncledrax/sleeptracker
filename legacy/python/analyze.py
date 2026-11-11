#!/usr/bin/env python3
"""
Analysis of one SleepLogger night.

    python analyze.py <session-folder> [--plot]

Reads accel.csv, gyro.csv (if present) and hr.csv, finds movement events,
measures the heart-rate response to them, estimates the breathing rate in quiet phases and
flags periodic heart-rate spike patterns (cyclic variation of heart rate).
Writes movement_events.csv, breathing.csv, cvhr_episodes.csv, per_minute.csv
and summary.txt into the folder.
"""
import argparse
import warnings
from pathlib import Path

import fitbit as F
import numpy as np
import pandas as pd
from scipy import signal

ACTIVITY_WINDOW_S = 1.0     # window for movement intensity
MERGE_GAP_S = 5.0           # events with a smaller gap are merged
MIN_EVENT_S = 1.0
THRESHOLD_K = 6.0           # threshold = median + K * MAD of resting activity
MIN_THRESHOLD = 0.05        # m/s², floor so sensor noise/breathing never counts as movement
HR_PRE_S, HR_POST_S = 30, 60
BREATH_WINDOW_S = 120
BREATH_STEP_S = 30
BREATH_BAND_HZ = (0.1, 0.5)  # 6–30 breaths/min
BREATH_MIN_QUALITY = 0.4
CVHR_MIN_RISE_BPM = 6        # HR spike above the 3-min median
CVHR_CYCLE_S = (25, 100)     # spacing of consecutive spikes
CVHR_MIN_CYCLES = 4


def load(session: Path, zone=None):
    zone = zone or F.session_zone(session)
    acc = pd.read_csv(session / "accel.csv")
    hr = pd.read_csv(session / "hr.csv")
    acc["t"] = pd.to_datetime(acc.epoch_ms, unit="ms", utc=True).dt.tz_convert(zone)
    hr["t"] = pd.to_datetime(hr.epoch_ms, unit="ms", utc=True).dt.tz_convert(zone)
    hr = hr[(hr.bpm > 30) & (hr.accuracy >= 2)]  # 0/1 = unreliable or no skin contact
    gyro_path = session / "gyro.csv"
    gyro = pd.read_csv(gyro_path).sort_values("epoch_ms") if gyro_path.exists() else None
    return acc.sort_values("epoch_ms"), gyro, hr.sort_values("epoch_ms")


def resample(df: pd.DataFrame, grid: np.ndarray):
    """Resample onto a fixed grid (batching delivers irregular spacing)."""
    xyz = np.column_stack([np.interp(grid, df.epoch_ms, df[c]) for c in "xyz"])
    # mark gaps > 1 s (e.g. FIFO overflow) and edges as NaN instead of interpolating
    gaps = np.diff(df.epoch_ms.values) > 1000
    for a, b in zip(df.epoch_ms.values[:-1][gaps], df.epoch_ms.values[1:][gaps]):
        xyz[(grid > a) & (grid < b)] = np.nan
    xyz[(grid < df.epoch_ms.iloc[0]) | (grid > df.epoch_ms.iloc[-1])] = np.nan
    return xyz


def movement_events(grid, xyz, fs):
    mag = np.linalg.norm(xyz, axis=1)
    win = int(ACTIVITY_WINDOW_S * fs)
    s = pd.Series(mag)
    # std of the magnitude per window: posture changes and twitches, independent of gravity direction
    activity = s.rolling(win, center=True, min_periods=win // 2).std().values
    baseline = np.nanmedian(activity)
    mad = np.nanmedian(np.abs(activity - baseline)) or 1e-3
    thr = max(baseline + THRESHOLD_K * mad, MIN_THRESHOLD)
    active = np.nan_to_num(activity) > thr

    events, start = [], None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            events.append([start, i]); start = None
    if start is not None:
        events.append([start, len(active)])

    merged = []
    for e in events:
        if merged and (e[0] - merged[-1][1]) / fs < MERGE_GAP_S:
            merged[-1][1] = e[1]
        else:
            merged.append(e)
    merged = [e for e in merged if (e[1] - e[0]) / fs >= MIN_EVENT_S]

    # posture change: compare gravity vector before/after
    rows = []
    for a, b in merged:
        pre_seg, post_seg = xyz[max(0, a - int(5 * fs)):a], xyz[b:b + int(5 * fs)]
        angle = np.nan
        if len(pre_seg) and len(post_seg):
            pre, post = np.nanmean(pre_seg, axis=0), np.nanmean(post_seg, axis=0)
            cos = np.dot(pre, post) / (np.linalg.norm(pre) * np.linalg.norm(post) + 1e-9)
            angle = float(np.degrees(np.arccos(np.clip(cos, -1, 1))))
        rows.append({
            "start_ms": grid[a], "end_ms": grid[min(b, len(grid) - 1)],
            "duration_s": (b - a) / fs,
            "peak_activity": float(np.nanmax(activity[a:b])),
            "orientation_change_deg": angle,
        })
    return pd.DataFrame(rows), activity, thr


def hr_response(events: pd.DataFrame, hr: pd.DataFrame):
    if hr.empty or events.empty:
        return events
    hr_s = hr.set_index("epoch_ms").bpm
    pre, peak = [], []
    for _, e in events.iterrows():
        before = hr_s[(hr_s.index >= e.start_ms - HR_PRE_S * 1000) & (hr_s.index < e.start_ms)]
        after = hr_s[(hr_s.index >= e.start_ms) & (hr_s.index <= e.end_ms + HR_POST_S * 1000)]
        pre.append(before.median() if len(before) else np.nan)
        peak.append(after.max() if len(after) else np.nan)
    events["hr_before"] = pre
    events["hr_peak_after"] = peak
    events["hr_delta"] = events.hr_peak_after - events.hr_before
    return events


def principal_component(seg):
    """Projection onto the direction of largest variance: uses all three axes instead of one."""
    seg = seg - seg.mean(axis=0)
    _, vecs = np.linalg.eigh(np.cov(seg.T))
    return seg @ vecs[:, -1]


def autocorr_rate(x, fs):
    """Breaths/min from the first autocorrelation peak; quality = height of the peak (0–1)."""
    x = (x - x.mean()) / (x.std() + 1e-12)
    ac = np.correlate(x, x, mode="full")[len(x) - 1:] / len(x)
    lo, hi = int(fs / BREATH_BAND_HZ[1]), int(fs / BREATH_BAND_HZ[0])
    peaks, _ = signal.find_peaks(ac[lo:hi])
    if not len(peaks):
        return np.nan, 0.0
    # Take the shortest period whose peak is almost as high as the highest one – otherwise irregular
    # breathing often lets twice the period win (half the rate)
    heights = ac[lo:hi][peaks]
    k = lo + peaks[np.argmax(heights >= 0.8 * heights.max())]
    # parabola through the peak for sub-sample resolution
    a, b, c = ac[k - 1], ac[k], ac[k + 1]
    shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    return 60.0 * fs / (k + shift), float(max(ac[k], 0.0))


def breathing_estimates(grid, sources, activity, thr, fs):
    """
    Only in quiet windows (BREATH_WINDOW_S, every BREATH_STEP_S): per sensor band-pass
    0.1–0.5 Hz, principal component across all axes, period via autocorrelation.
    Gyro and accelerometer are estimated separately; the better quality wins,
    if both agree they are averaged. Then temporal smoothing (rolling median);
    outliers against the trend get a lower quality.
    At the wrist the signal stays tiny – ignore values with quality < BREATH_MIN_QUALITY.
    """
    sos = signal.butter(2, BREATH_BAND_HZ, btype="band", fs=fs, output="sos")
    n, step = int(BREATH_WINDOW_S * fs), int(BREATH_STEP_S * fs)
    out = []
    for i in range(0, len(grid) - n, step):
        if np.nanmax(np.nan_to_num(activity[i:i + n], nan=np.inf)) > thr * 0.5:
            continue
        est = {}
        for name, data in sources.items():
            seg = data[i:i + n]
            if np.isnan(seg).any():
                continue
            filt = signal.sosfiltfilt(sos, seg - seg.mean(axis=0), axis=0)
            est[name] = autocorr_rate(principal_component(filt), fs)
        est = {k: v for k, v in est.items() if not np.isnan(v[0])}
        if not est:
            continue
        best = max(est, key=lambda k: est[k][1])
        rate, quality = est[best]
        if len(est) == 2:
            (r1, q1), (r2, q2) = est.values()
            if abs(r1 - r2) <= 2:
                rate, quality, best = (r1 * q1 + r2 * q2) / (q1 + q2), max(q1, q2), "both"
        out.append({"epoch_ms": grid[i + n // 2], "breaths_per_min": rate,
                    "quality": quality, "source": best})
    df = pd.DataFrame(out)
    if df.empty:
        return df
    good = df.quality >= BREATH_MIN_QUALITY
    trend = df.breaths_per_min.where(good).rolling(5, center=True, min_periods=2).median()
    df["breaths_per_min_smooth"] = trend
    df.loc[(df.breaths_per_min - trend).abs() > 3, "quality"] *= 0.5
    return df


def cvhr_episodes(hr: pd.DataFrame, events: pd.DataFrame):
    """
    Cyclic variation of heart rate: HR spikes (arousal at the end of a breathing pause)
    that repeat at least CVHR_MIN_CYCLES times, 25–100 s apart.
    Typical of sleep-disordered breathing, but no proof of apnea and no AHI.
    """
    if len(hr) < 600:
        return pd.DataFrame(), pd.DataFrame()
    t = np.arange(hr.epoch_ms.iloc[0], hr.epoch_ms.iloc[-1], 1000.0)
    bpm = np.interp(t, hr.epoch_ms, hr.bpm)
    gaps = np.diff(hr.epoch_ms.values) > 5000
    for a, b in zip(hr.epoch_ms.values[:-1][gaps], hr.epoch_ms.values[1:][gaps]):
        bpm[(t > a) & (t < b)] = np.nan
    s = pd.Series(bpm)
    detr = (s - s.rolling(180, center=True, min_periods=60).median()).fillna(0).values
    with warnings.catch_warnings():  # flat sections cause harmless prominence warnings
        warnings.simplefilter("ignore", RuntimeWarning)
        peaks, props = signal.find_peaks(detr, prominence=CVHR_MIN_RISE_BPM, distance=15, wlen=40)
    if not len(peaks):
        return pd.DataFrame(), pd.DataFrame()

    mv = events[["start_ms", "end_ms"]].values if not events.empty else np.empty((0, 2))
    # spikes during long movement (>30 s: awake, got up) are not arousals
    long_mv = mv[(mv[:, 1] - mv[:, 0]) > 30_000] if len(mv) else mv
    awake = np.array([((long_mv[:, 0] - 30_000 <= x) & (long_mv[:, 1] + 30_000 >= x)).any()
                      for x in t[peaks]], bool)
    peaks = peaks[~awake]
    props = {k: v[~awake] for k, v in props.items()}
    if not len(peaks):
        return pd.DataFrame(), pd.DataFrame()
    pk = pd.DataFrame({
        "epoch_ms": t[peaks], "rise_bpm": props["prominences"],
        "with_movement": [bool(((mv[:, 0] - 10_000 <= x) & (mv[:, 1] + 10_000 >= x)).any())
                          for x in t[peaks]],
    })

    # build chains of regularly spaced spikes
    rows, chain = [], [0]
    iv = np.diff(pk.epoch_ms.values) / 1000
    for j, d in enumerate(iv, start=1):
        if CVHR_CYCLE_S[0] <= d <= CVHR_CYCLE_S[1]:
            chain.append(j)
            continue
        rows.append(chain); chain = [j]
    rows.append(chain)

    episodes = []
    for c in rows:
        if len(c) < CVHR_MIN_CYCLES:
            continue
        sub = pk.iloc[c]
        cyc = np.diff(sub.epoch_ms.values) / 1000
        episodes.append({
            "start_ms": sub.epoch_ms.iloc[0], "end_ms": sub.epoch_ms.iloc[-1],
            "cycles": len(c), "mean_cycle_s": cyc.mean(),
            "cycle_regularity_cv": cyc.std() / cyc.mean(),
            "mean_rise_bpm": sub.rise_bpm.mean(),
            "share_with_movement": sub.with_movement.mean(),
        })
    return pd.DataFrame(episodes), pk


def battery_drain(session: Path):
    """Battery level from events.csv (app logs every 10 min): (start %, end %, %/h) or None."""
    p = session / "events.csv"
    if not p.exists():
        return None
    ev = pd.read_csv(p)
    bat = ev[ev.event.str.startswith("battery ")]
    if len(bat) < 2:
        return None
    pct = bat.event.str.split().str[1].astype(float)
    hours = (bat.epoch_ms.iloc[-1] - bat.epoch_ms.iloc[0]) / 3.6e6
    return pct.iloc[0], pct.iloc[-1], (pct.iloc[0] - pct.iloc[-1]) / max(hours, 1e-9)


def per_minute(grid, activity, events, hr, breath, cvhr, zone=F.TZ):
    df = pd.DataFrame({"epoch_ms": grid, "activity": activity})
    df["minute"] = (df.epoch_ms // 60000) * 60000
    m = df.groupby("minute").activity.mean().to_frame("activity_mean")
    m["movement_events"] = 0
    if not events.empty:
        counts = ((events.start_ms // 60000) * 60000).value_counts()
        m.loc[m.index.intersection(counts.index), "movement_events"] = counts
    if not hr.empty:
        hr_m = hr.assign(minute=(hr.epoch_ms // 60000) * 60000).groupby("minute").bpm
        m["hr_mean"] = hr_m.mean(); m["hr_min"] = hr_m.min(); m["hr_max"] = hr_m.max()
    if not breath.empty:
        good = breath[breath.quality >= BREATH_MIN_QUALITY]
        m["breaths_per_min"] = good.assign(minute=(good.epoch_ms // 60000) * 60000) \
            .groupby("minute").breaths_per_min.mean()
    m["cvhr_episode"] = False
    for _, e in cvhr.iterrows():
        m.loc[(m.index >= e.start_ms - 60000) & (m.index <= e.end_ms), "cvhr_episode"] = True
    m.index = pd.to_datetime(m.index, unit="ms", utc=True).tz_convert(zone)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--fs", type=float, default=25.0)
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--fitbit", type=Path, help="Fitbit export (default: fitbit.json in the session folder)")
    ap.add_argument("--time-zone", help="IANA time zone for offset-free input and reports")
    args = ap.parse_args()
    zone = args.time_zone or F.session_zone(args.session)

    acc, gyro, hr = load(args.session, zone)
    grid = np.arange(acc.epoch_ms.iloc[0], acc.epoch_ms.iloc[-1], 1000.0 / args.fs)
    xyz = resample(acc, grid)
    sources = {"accel": xyz}
    if gyro is not None and len(gyro) > 100:
        sources["gyro"] = resample(gyro, grid)
    events, activity, thr = movement_events(grid, xyz, args.fs)
    events = hr_response(events, hr)
    breath = breathing_estimates(grid, sources, activity, thr, args.fs)
    cvhr, cvhr_peaks = cvhr_episodes(hr, events)
    minutes = per_minute(grid, activity, events, hr, breath, cvhr, zone)

    fb_data, fb_path = F.find_export(args.session, args.fitbit)
    fb = episodes = None
    if fb_data:
        fb = F.load(fb_data, zone)
        minutes = F.annotate(minutes, fb, F.wrist_pose(acc, zone))
        episodes = F.low_spo2_episodes(minutes, events)

    hours = (grid[-1] - grid[0]) / 3.6e6
    gap_s = np.isnan(xyz[:, 0]).sum() / args.fs
    good_breath = breath[breath.quality >= BREATH_MIN_QUALITY] if not breath.empty else breath
    lines = [
        f"Recording: {hours:.2f} h, data gaps: {gap_s / 60:.1f} min",
        *([f"Battery: {b[0]:.0f} % → {b[1]:.0f} % ({b[2]:.1f} %/h, "
            f"8 h ≈ {b[2] * 8:.0f} %)"] if (b := battery_drain(args.session)) else []),
        f"Movement events: {len(events)} ({len(events) / max(hours, 1e-9):.1f}/h)",
    ]
    if not events.empty:
        big = events[events.orientation_change_deg > 30]
        lines += [
            f"  of which posture changes (>30°): {len(big)}",
            f"  mean duration: {events.duration_s.mean():.1f} s",
        ]
        if "hr_delta" in events:
            lines.append(f"  mean HR response: +{events.hr_delta.mean():.1f} bpm")
    if not hr.empty:
        lines.append(f"Heart rate: min {hr.bpm.min():.0f}, median {hr.bpm.median():.0f}, "
                     f"max {hr.bpm.max():.0f} bpm ({len(hr)} values)")
    lines.append(f"Breathing rate: {len(good_breath)} of {len(breath)} quiet windows with "
                 f"quality ≥{BREATH_MIN_QUALITY}" +
                 (f", median {good_breath.breaths_per_min.median():.1f}/min, source: "
                  + ", ".join(f"{k} {v}" for k, v in good_breath.source.value_counts().items())
                  if len(good_breath) else ""))
    if not cvhr.empty:
        mins = (cvhr.end_ms - cvhr.start_ms).sum() / 60000
        lines += [
            f"Periodic HR spike episodes: {len(cvhr)} ({mins:.0f} min, "
            f"{cvhr.cycles.sum() / max(hours, 1e-9):.1f} cycles/h)",
            f"  mean cycle {cvhr.mean_cycle_s.mean():.0f} s, rise "
            f"{cvhr.mean_rise_bpm.mean():.1f} bpm, with movement: "
            f"{cvhr.share_with_movement.mean() * 100:.0f} %",
            "  Note: the pattern fits sleep-disordered breathing but is no proof.",
        ]
    else:
        lines.append("Periodic HR spike episodes: none")
    if fb:
        lines += [f"(Fitbit export: {fb_path.name})"] + \
            F.summary_lines(fb, minutes, breath, events, BREATH_MIN_QUALITY)[1:]
        for _, e in episodes.iterrows():
            lines.append(f"  SpO2 < {F.LOW_SPO2} %: {e.start:%H:%M}–{e.end:%H:%M} ({e.minutes} min, "
                         f"min {e.spo2_min:.1f} %, arm pose ±{e.max_pose_change_deg:.0f}°, "
                         f"stage {e.stage}) → {e.verdict}")
        if episodes is not None and len(episodes):
            lines.append("  Note: watch SpO2 at the wrist is error-prone. If this repeats, "
                         "check with a finger pulse oximeter.")
    summary = "\n".join(lines)
    print(summary)

    (args.session / "summary.txt").write_text(summary + "\n")
    events.to_csv(args.session / "movement_events.csv", index=False)
    breath.to_csv(args.session / "breathing.csv", index=False)
    cvhr.to_csv(args.session / "cvhr_episodes.csv", index=False)
    cvhr_peaks.to_csv(args.session / "cvhr_peaks.csv", index=False)
    minutes.to_csv(args.session / "per_minute.csv")
    if episodes is not None:
        episodes.to_csv(args.session / "spo2_episodes.csv", index=False)

    if args.plot:
        import matplotlib.pyplot as plt
        if fb:
            fig, ax = plt.subplots(6, 1, sharex=True, figsize=(14, 15),
                                   gridspec_kw={"height_ratios": [1, 1, 1, 1.4, 1.2, 1.2]})
            F.plot_extra(ax[0], ax[5], fb, minutes, episodes)
            ax = [ax[1], ax[2], ax[3], ax[4], ax[0], ax[5]]
        else:
            fig, ax = plt.subplots(4, 1, sharex=True, figsize=(14, 10))
        ax[0].plot(minutes.index, minutes.activity_mean); ax[0].set_ylabel("Activity")
        ax[1].bar(minutes.index, minutes.movement_events, width=1 / 1440)
        ax[1].set_ylabel("Events/min")
        if "hr_mean" in minutes:
            ax[2].plot(minutes.index, minutes.hr_mean, label="SleepLogger")
            if "fitbit_hr" in minutes:
                ax[2].plot(minutes.index, minutes.fitbit_hr, alpha=0.5, label="Fitbit")
                ax[2].legend(loc="upper right")
            ax[2].set_ylabel("Heart rate")
            for _, e in cvhr.iterrows():
                ax[2].axvspan(pd.to_datetime(e.start_ms, unit="ms", utc=True).tz_convert(zone),
                              pd.to_datetime(e.end_ms, unit="ms", utc=True).tz_convert(zone),
                              color="tab:red", alpha=0.2)
        if "breaths_per_min" in minutes and "stage" in minutes:
            col = {"wake": "tab:red", "rem": "tab:purple", "light": "tab:cyan", "deep": "tab:blue"}
            for st, c in col.items():
                sel = minutes[minutes.stage == st]
                ax[3].plot(sel.index, sel.breaths_per_min, ".", color=c, label=st)
            ax[3].legend(loc="upper right", ncol=4)
        elif "breaths_per_min" in minutes:
            ax[3].plot(minutes.index, minutes.breaths_per_min, ".")
        ax[3].set_ylabel("Breaths/min")
        fig.tight_layout()
        fig.savefig(args.session / "night.png", dpi=120)
        print(f"Plot: {args.session / 'night.png'}")


if __name__ == "__main__":
    main()
