"""
Beat-to-beat analysis of the raw pulse wave (raw_ppg.csv, button "Start + PPG").

- Channel choice: the channel with the clearest pulse wave in quiet phases (or --channel)
- Beats: band-pass 0.6–3.5 Hz, peaks at least 0.33 s apart with prominence relative to the local amplitude
- Quality: movement (accelerometer) ±3 s and shape similarity to the average pulse wave
- HRV: SDNN/RMSSD only from clean normal-to-normal intervals
- Ectopic beat candidates (only in clean sections):
    "premature": interval < 80 % of the local median, followed by a pause, both together ≈ 2 intervals
    "missed pulse": one interval ≈ twice as long, neighbours normal (ectopic beat without a palpable pulse
                    OR a missed beat – judged by the mid wave and the next beat's amplitude)
  These are candidates, not a diagnosis. Validation only with a simultaneous ECG.

    python ppg.py ../sessions/<session> [--plot] [--channel 6]
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import signal

from fitbit import session_zone
BAND = (0.6, 3.5)
MOTION_THR = 0.03       # m/s², std of |a| over 1 s
MOTION_PAD_S = 3.0
MIN_CORR = 0.6          # shape similarity of a beat to the template
WIN_MED = 9             # beats for the local median


def load_ppg(session: Path):
    df = pd.read_csv(session / "raw_ppg.csv")
    vals = df["values"].astype(str).str.split(" ", expand=True).apply(pd.to_numeric, errors="coerce")
    vals.columns = [int(c) for c in vals.columns]
    t = df.epoch_ms.values.astype(float)
    high = np.maximum.accumulate(np.r_[-np.inf, np.where(np.isfinite(t), t, -np.inf)])[:-1]
    keep = np.isfinite(t) & (t > high)
    return t[keep], vals[keep].reset_index(drop=True)


def motion_mask(session: Path, t_ms):
    acc = pd.read_csv(session / "accel.csv").sort_values("epoch_ms")
    mag = np.linalg.norm(acc[["x", "y", "z"]].values, axis=1)
    act = pd.Series(mag).rolling(25, center=True, min_periods=5).std().fillna(0).values
    moving = np.interp(t_ms, acc.epoch_ms.values, act) > MOTION_THR
    pad = int(MOTION_PAD_S * 100)
    return np.convolve(moving.astype(float), np.ones(2 * pad + 1), mode="same") > 0


def bandpass(x, fs):
    b, a = signal.butter(3, BAND, btype="band", fs=fs)
    x = pd.Series(x).interpolate(limit_direction="both").values
    return signal.filtfilt(b, a, x - np.mean(x))


def pick_channel(vals, fs, still):
    best, score = None, 0
    for c in vals.columns:
        x = vals[c].values.astype(float)
        if np.nanstd(x) == 0 or (x < -1000).mean() > 0.05:     # status channels with sentinel values
            continue
        y = bandpass(x, fs)[still]
        if len(y) < fs * 20:
            continue
        f, p = signal.welch(y, fs=fs, nperseg=int(fs * 8))
        band = (f >= 0.7) & (f <= 3.0)
        s = p[band].max() / p[band].sum()
        if s > score:
            best, score = c, s
    return best, score


def detect_beats(y, fs):
    amp = pd.Series(np.abs(y)).rolling(int(2 * fs), center=True, min_periods=int(fs / 2)).median().values
    pk, prop = signal.find_peaks(y, distance=int(0.33 * fs), prominence=1e-9)
    keep = prop["prominences"] >= 0.8 * amp[pk]
    return pk[keep], prop["prominences"][keep], amp


def beat_corr(y, pk, fs):
    a, b = int(0.3 * fs), int(0.5 * fs)
    segs, idx = [], []
    for i, p in enumerate(pk):
        if p - a >= 0 and p + b < len(y):
            s = y[p - a:p + b]
            segs.append((s - s.mean()) / (s.std() + 1e-9)); idx.append(i)
    corr = np.full(len(pk), np.nan)
    if len(segs) > 10:
        segs = np.array(segs)
        tmpl = np.median(segs, axis=0)
        corr[idx] = segs @ tmpl / (np.linalg.norm(tmpl) * np.sqrt(segs.shape[1]))
    return corr


def analyse(t_ms, y, fs, moving):
    pk, prom, amp = detect_beats(y, fs)
    corr = beat_corr(y, pk, fs)
    beats = pd.DataFrame({"epoch_ms": t_ms[pk], "amp": prom, "corr": corr, "moving": moving[pk]})
    beats["ibi_ms"] = beats.epoch_ms.diff()
    # an interval is clean if both beats are still and well-shaped
    good = (~beats.moving) & (beats["corr"] >= MIN_CORR)
    beats["clean"] = good & good.shift(fill_value=False) & (beats.ibi_ms.between(300, 2500))
    med = beats.ibi_ms.where(beats.clean).rolling(WIN_MED, center=True, min_periods=4).median()
    med = med.ffill().bfill()
    beats["ibi_med"] = med
    beats["flag"] = ""

    ibi, m = beats.ibi_ms.values, med.values
    amp_med = beats.amp.where(beats.clean).rolling(WIN_MED, center=True, min_periods=4).median().ffill().bfill().values
    events = []
    for i in range(2, len(beats) - 2):
        # still around the event (beats i-4 … i+3), otherwise the local median is unreliable
        if beats.moving.iloc[max(0, i - 4):i + 4].any() or not np.isfinite(m[i]):
            continue
        r = ibi[i] / m[i]
        r_next = ibi[i + 1] / m[i]
        if r < 0.8 and r_next > 1.1 and 1.75 <= r + r_next <= 2.3 and beats.clean.iloc[i - 1]:
            kind = "premature"
        elif 1.75 <= r <= 2.3 and 0.85 <= ibi[i - 1] / m[i] <= 1.15 and 0.85 <= ibi[i + 1] / m[i] <= 1.15:
            kind = "missed pulse"
        else:
            continue
        # mid wave in the long interval? (small wave = weak extra beat)
        a, b = np.searchsorted(t_ms, beats.epoch_ms.iloc[i - 1] + 250), np.searchsorted(t_ms, beats.epoch_ms.iloc[i] - 250)
        mid = (y[a:b].max() - y[a:b].min()) / (2 * amp_med[i]) if b > a else np.nan
        post = beats.amp.iloc[i + (1 if kind == "premature" else 0)] / amp_med[i]
        beats.loc[beats.index[i], "flag"] = kind
        events.append({"epoch_ms": beats.epoch_ms.iloc[i], "kind": kind, "ibi_ms": ibi[i],
                       "ibi_next_ms": ibi[i + 1], "ibi_median_ms": m[i],
                       "mid_wave_rel": round(mid, 2), "next_beat_amp_rel": round(post, 2)})
    return beats, pd.DataFrame(events)


def hrv(beats):
    nn = beats[beats.clean & (beats.flag == "")].copy()
    near = beats.flag.ne("").rolling(3, center=True, min_periods=1).max().astype(bool)
    nn = nn[~near.reindex(nn.index).values]
    # usual artifact rule: more than 20 % away from the local median = no reliable NN interval
    nn = nn[(nn.ibi_ms / nn.ibi_med - 1).abs() <= 0.2]
    d = nn.ibi_ms.diff().where(nn.index.to_series().diff() == 1)
    return nn, (nn.ibi_ms.std(), np.sqrt(np.mean(d.dropna() ** 2)) if d.notna().any() else np.nan)


def felt_markers(session: Path):
    p = session / "events.csv"
    if not p.exists():
        return np.array([])
    ev = pd.read_csv(p)
    return np.sort(ev.epoch_ms[ev.event.astype(str).str.strip('"') == "felt"].values.astype(float))


def check_felt(markers, beats, events, before_s=8.0, after_s=1.0):
    """
    Per "felt" marker: a premature beat/pause pattern in the before_s seconds before it?
    The tapping movement comes AFTER the palpitation, so the motion mask is ignored here
    and only the time up to shortly before the marker is examined. Reference interval: median of the clean beats of the minute before.
    """
    rows = []
    for m in markers:
        ref = beats[(beats.epoch_ms > m - 60_000) & (beats.epoch_ms < m - before_s * 1000) & beats.clean].ibi_ms
        if len(ref) < 10:
            ref = beats[beats.clean].ibi_ms
        med = ref.median()
        win = beats[(beats.epoch_ms > m - before_s * 1000) & (beats.epoch_ms <= m + after_s * 1000)]
        r = (win.ibi_ms / med).values
        found, dt = "", np.nan
        for i in range(len(r)):
            nxt = r[i + 1] if i + 1 < len(r) else np.nan
            if r[i] < 0.8 and nxt > 1.1 and 1.75 <= r[i] + nxt <= 2.3:
                found = "premature"
            elif 1.75 <= r[i] <= 2.3:
                found = "missed pulse"
            elif r[i] > 1.3 or r[i] < 0.75:
                found = "irregular"
            if found:
                dt = (win.epoch_ms.iloc[i] - m) / 1000
                break
        auto = events[(events.epoch_ms > m - before_s * 1000) & (events.epoch_ms <= m + after_s * 1000)] \
            if not events.empty else events
        rows.append({"epoch_ms": m, "pattern": found or "none", "seconds_before_marker": dt,
                     "auto_candidate": len(auto) > 0, "median_ibi_ms": med,
                     "beats_in_window": len(win)})
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--channel", type=int)
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()
    zone = session_zone(args.session)

    t_ms, vals = load_ppg(args.session)
    fs = 1000 / np.median(np.diff(t_ms))
    moving = motion_mask(args.session, t_ms)
    ch, sharp = (args.channel, np.nan) if args.channel is not None else pick_channel(vals, fs, ~moving)
    if ch is None:
        raise SystemExit("No channel with a recognisable pulse wave.")
    y = bandpass(vals[ch].values.astype(float), fs)
    beats, events = analyse(t_ms, y, fs, moving)
    nn, (sdnn, rmssd) = hrv(beats)

    hours = (t_ms[-1] - t_ms[0]) / 3.6e6
    clean_h = beats.ibi_ms[beats.clean].sum() / 3.6e6
    lines = [
        f"PPG: channel v{ch}, {fs:.0f} Hz, {hours * 60:.1f} min recording, of which {clean_h / hours * 100:.0f} % "
        f"clean beat sequence",
        f"Beats: {len(beats)}, heart rate from intervals {60000 / nn.ibi_ms.mean():.1f} bpm" if len(nn) else "Beats: too few",
        f"HRV (clean NN intervals only): SDNN {sdnn:.0f} ms, RMSSD {rmssd:.0f} ms",
    ]
    if (args.session / "hr.csv").exists():
        hr = pd.read_csv(args.session / "hr.csv")
        hr = hr[(hr.bpm > 30) & (hr.accuracy >= 2)]
        if len(hr) and len(nn):
            lines.append(f"Watch heart-rate sensor in the same period: {hr.bpm.mean():.1f} bpm")
    if events.empty:
        lines.append("Ectopic beat candidates: none")
    else:
        per_h = len(events) / max(clean_h, 1e-9)
        lines.append(f"Ectopic beat candidates: {len(events)} ({per_h:.0f} per clean hour) – "
                     + ", ".join(f"{k} {n}" for k, n in events.kind.value_counts().items()))
        for e in events.itertuples():
            ts = pd.to_datetime(e.epoch_ms, unit="ms", utc=True).tz_convert(zone).strftime("%H:%M:%S")
            lines.append(f"  {ts} {e.kind}: {e.ibi_ms:.0f} → {e.ibi_next_ms:.0f} ms (median {e.ibi_median_ms:.0f}), "
                         f"mid wave {e.mid_wave_rel}, next beat ×{e.next_beat_amp_rel}")
        lines.append("Note: candidates, not a diagnosis. 'missed pulse' can also be a missed beat.")

    markers = felt_markers(args.session)
    felt = check_felt(markers, beats, events) if len(markers) else pd.DataFrame()
    if len(felt):
        hit = felt.pattern.isin(["premature", "missed pulse"])
        irr = felt.pattern == "irregular"
        # How often would the pattern appear by chance in a 9-s window? Roughly via the candidate rate.
        minutes = len(beats) and (beats.epoch_ms.iloc[-1] - beats.epoch_ms.iloc[0]) / 60000
        chance = 1 - np.exp(-len(events) / max(minutes, 1e-9) * 9 / 60) if minutes else np.nan
        lines.append(f"Felt: {len(felt)}× – of which {hit.sum()} with an ectopic pattern in the 8 s before, "
                     f"{irr.sum()} only irregular, {(~hit & ~irr).sum()} unremarkable "
                     f"(chance of a random hit per window ≈ {chance * 100:.0f} %)")
        for f in felt.itertuples():
            ts = pd.to_datetime(f.epoch_ms, unit="ms", utc=True).tz_convert(zone).strftime("%H:%M:%S")
            lines.append(f"  {ts}: {f.pattern}" + (f" ({-f.seconds_before_marker:.1f} s before)"
                                                  if np.isfinite(f.seconds_before_marker) else ""))
        auto_hit = sum(((markers > e - 1000) & (markers < e + 8000)).any() for e in events.epoch_ms) \
            if not events.empty else 0
        lines.append(f"Automatic candidates without a felt marker in the 8 s after: {len(events) - auto_hit}")
        felt.to_csv(args.session / "ppg_felt.csv", index=False)

    text = "\n".join(lines)
    print(text)
    (args.session / "ppg_summary.txt").write_text(text + "\n", encoding="utf-8")
    beats.to_csv(args.session / "ppg_beats.csv", index=False)
    events.to_csv(args.session / "ppg_events.csv", index=False)

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        snips = [(e.epoch_ms, e.kind, False) for e in events.itertuples()]
        snips += [(m, "felt", True) for m in markers]
        snips = sorted(snips)[:12]
        n_ev = len(snips)
        fig = plt.figure(figsize=(12, 4 + 2 * ((n_ev + 1) // 2)))
        gs = fig.add_gridspec(2 + (n_ev + 1) // 2, 2)
        ax = fig.add_subplot(gs[0:2, :])
        tt = pd.to_datetime(beats.epoch_ms, unit="ms", utc=True).dt.tz_convert(zone).dt.tz_localize(None)
        ax.plot(tt[beats.clean], beats.ibi_ms[beats.clean], ".", ms=2, label="clean")
        ax.plot(tt[~beats.clean], beats.ibi_ms[~beats.clean], ".", ms=2, color="lightgrey", label="movement/uncertain")
        f = beats.flag != ""
        ax.plot(tt[f], beats.ibi_ms[f], "rx", ms=6, label="candidate")
        ax.set_ylim(300, 2000)
        ax.set_ylabel("Beat interval ms")
        for m in markers:
            ax.axvline(pd.to_datetime(m, unit="ms", utc=True).tz_convert(zone).tz_localize(None),
                       color="tab:green", lw=0.8)
        ax.legend(fontsize=8)
        ax.set_title("green line = felt", fontsize=8)
        for k, (t0, label, is_marker) in enumerate(snips):
            a = fig.add_subplot(gs[2 + k // 2, k % 2])
            lo, hi = (8000, 2000) if is_marker else (4000, 3000)
            sel = (t_ms > t0 - lo) & (t_ms < t0 + hi)
            a.plot((t_ms[sel] - t0) / 1000, y[sel], lw=0.8)
            bp = beats[(beats.epoch_ms > t0 - lo) & (beats.epoch_ms < t0 + hi)]
            a.plot((bp.epoch_ms - t0) / 1000, np.interp(bp.epoch_ms, t_ms, y), "r.", ms=4)
            if is_marker:
                a.axvline(0, color="tab:green", lw=1)
            a.set_title(f"{pd.to_datetime(t0, unit='ms', utc=True).tz_convert(zone):%H:%M:%S} {label}", fontsize=8)
            a.tick_params(labelsize=7)
        fig.tight_layout()
        out = args.session / "ppg.png"
        fig.savefig(out, dpi=100)
        print(f"Plot: {out}")


if __name__ == "__main__":
    main()
