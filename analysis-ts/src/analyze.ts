/**
 * Analysis of one SleepLogger night (TypeScript version of legacy/python/analyze.py).
 *
 *     npx tsx src/analyze.ts <session-folder> [--fitbit file.json]
 *
 * Movement events, heart-rate response, breathing rate in quiet phases, periodic HR spikes (CVHR),
 * battery and – if fitbit.json is in the folder – the comparison with Fitbit.
 * Writes the same files as the Python version: summary.txt, movement_events.csv, breathing.csv,
 * cvhr_episodes.csv, cvhr_peaks.csv, per_minute.csv, spo2_episodes.csv.
 */
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { autocorr, butterBandpass, findPeaks, principalComponent, sosfiltfilt } from "./lib/dsp.ts";
import { argValue, f, hm, isoLocal, sessionTimeZone, readEvents, readNumericCsv, sortBy, writeCsv } from "./lib/io.ts";
import { interp, max, mean, median, min, rollingMedian, rollingStd, std } from "./lib/stats.ts";
import * as F from "./fitbit.ts";

const ACTIVITY_WINDOW_S = 1.0;
const MERGE_GAP_S = 5.0;
const MIN_EVENT_S = 1.0;
const THRESHOLD_K = 6.0;
const MIN_THRESHOLD = 0.05;
const HR_PRE_S = 30, HR_POST_S = 60;
const BREATH_WINDOW_S = 120;
const BREATH_STEP_S = 30;
const BREATH_BAND_HZ: [number, number] = [0.1, 0.5];
export const BREATH_MIN_QUALITY = 0.4;
const CVHR_MIN_RISE_BPM = 6;
const CVHR_CYCLE_S: [number, number] = [25, 100];
const CVHR_MIN_CYCLES = 4;
const MIN = 60000;

type Cols = Record<string, Float64Array>;
export type Xyz = [Float64Array, Float64Array, Float64Array];

export function load(session: string) {
  const acc = sortBy(readNumericCsv(join(session, "accel.csv"), ["epoch_ms", "x", "y", "z"]), "epoch_ms");
  const hrRaw = readNumericCsv(join(session, "hr.csv"), ["epoch_ms", "bpm", "accuracy"]);
  const keep: number[] = [];
  for (let i = 0; i < hrRaw.bpm.length; i++) if (hrRaw.bpm[i] > 30 && hrRaw.accuracy[i] >= 2) keep.push(i);
  const hr = sortBy({ epoch_ms: Float64Array.from(keep, (i) => hrRaw.epoch_ms[i]), bpm: Float64Array.from(keep, (i) => hrRaw.bpm[i]) }, "epoch_ms");
  const gp = join(session, "gyro.csv");
  const gyro = existsSync(gp) ? sortBy(readNumericCsv(gp, ["epoch_ms", "x", "y", "z"]), "epoch_ms") : null;
  return { acc, gyro, hr };
}

/** Resample onto a fixed grid; gaps > 1 s and edges become NaN. */
export function resample(df: Cols, grid: Float64Array): Xyz {
  const t = df.epoch_ms;
  const xyz = (["x", "y", "z"] as const).map((c) => interp(grid, t, df[c])) as Xyz;
  for (let i = 0; i + 1 < t.length; i++) {
    if (t[i + 1] - t[i] > 1000) {
      // grid > a && grid < b
      let k = Math.max(0, Math.ceil((t[i] - grid[0]) / (grid[1] - grid[0])) - 1);
      for (; k < grid.length && grid[k] < t[i + 1]; k++) if (grid[k] > t[i]) for (const a of xyz) a[k] = NaN;
    }
  }
  for (let k = 0; k < grid.length; k++) if (grid[k] < t[0] || grid[k] > t[t.length - 1]) for (const a of xyz) a[k] = NaN;
  return xyz;
}

export interface MoveEvent {
  start_ms: number; end_ms: number; duration_s: number; peak_activity: number; orientation_change_deg: number;
  hr_before?: number; hr_peak_after?: number; hr_delta?: number;
}

export function movementEvents(grid: Float64Array, xyz: Xyz, fs: number) {
  const n = grid.length;
  const mag = new Float64Array(n);
  for (let i = 0; i < n; i++) mag[i] = Math.hypot(xyz[0][i], xyz[1][i], xyz[2][i]);
  const win = Math.trunc(ACTIVITY_WINDOW_S * fs);
  const activity = rollingStd(mag, win, win >> 1);
  const baseline = median(activity);
  const mad = median(activity.map((a) => Math.abs(a - baseline))) || 1e-3;
  const thr = Math.max(baseline + THRESHOLD_K * mad, MIN_THRESHOLD);
  const active = activity.map((a) => (Number.isNaN(a) ? 0 : a) > thr ? 1 : 0);

  const events: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < n; i++) {
    if (active[i] && start === null) start = i;
    else if (!active[i] && start !== null) { events.push([start, i]); start = null; }
  }
  if (start !== null) events.push([start, n]);
  const merged: [number, number][] = [];
  for (const e of events) {
    if (merged.length && (e[0] - merged[merged.length - 1][1]) / fs < MERGE_GAP_S) merged[merged.length - 1][1] = e[1];
    else merged.push([e[0], e[1]]);
  }
  const rows: MoveEvent[] = merged.filter(([a, b]) => (b - a) / fs >= MIN_EVENT_S).map(([a, b]) => {
    const p0 = Math.max(0, a - Math.trunc(5 * fs)), p1 = Math.min(n, b + Math.trunc(5 * fs));
    let angle = NaN;
    if (a > p0 && p1 > b) {
      const pre = xyz.map((ax) => mean(ax.subarray(p0, a)));
      const post = xyz.map((ax) => mean(ax.subarray(b, p1)));
      const cs = (pre[0] * post[0] + pre[1] * post[1] + pre[2] * post[2]) /
        (Math.hypot(pre[0], pre[1], pre[2]) * Math.hypot(post[0], post[1], post[2]) + 1e-9);
      angle = (Math.acos(Math.min(1, Math.max(-1, cs))) * 180) / Math.PI;
    }
    return { start_ms: grid[a], end_ms: grid[Math.min(b, n - 1)], duration_s: (b - a) / fs,
      peak_activity: max(activity.subarray(a, b)), orientation_change_deg: angle };
  });
  return { events: rows, activity, thr };
}

function hrResponse(events: MoveEvent[], hr: Cols) {
  if (!hr.bpm.length) return;
  for (const e of events) {
    const before: number[] = [], after: number[] = [];
    for (let i = 0; i < hr.epoch_ms.length; i++) {
      const t = hr.epoch_ms[i];
      if (t >= e.start_ms - HR_PRE_S * 1000 && t < e.start_ms) before.push(hr.bpm[i]);
      if (t >= e.start_ms && t <= e.end_ms + HR_POST_S * 1000) after.push(hr.bpm[i]);
    }
    e.hr_before = before.length ? median(before) : NaN;
    e.hr_peak_after = after.length ? max(after) : NaN;
    e.hr_delta = e.hr_peak_after - e.hr_before;
  }
}

/** Breaths/min from the first autocorrelation peak; quality = height of the peak. */
function autocorrRate(x: Float64Array, fs: number): [number, number] {
  const m = mean(x), sd = std(x, 0) + 1e-12;
  const z = x.map((v) => (v - m) / sd);
  const lo = Math.trunc(fs / BREATH_BAND_HZ[1]), hi = Math.trunc(fs / BREATH_BAND_HZ[0]);
  const ac = autocorr(z, hi + 1);
  const { peaks } = findPeaks(ac.subarray(lo, hi));
  if (!peaks.length) return [NaN, 0];
  const h = peaks.map((p) => ac[lo + p]);
  const best = Math.max(...h);
  const k = lo + peaks[h.findIndex((v) => v >= 0.8 * best)];
  const a = ac[k - 1], b = ac[k], c = ac[k + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
  return [(60 * fs) / (k + shift), Math.max(ac[k], 0)];
}

interface Breath { t: number; rate: number; quality: number; source: string; smooth?: number }

function breathingEstimates(grid: Float64Array, sources: [string, Xyz][], activity: Float64Array, thr: number, fs: number): Breath[] {
  const sos = butterBandpass(2, BREATH_BAND_HZ[0], BREATH_BAND_HZ[1], fs);
  const n = Math.trunc(BREATH_WINDOW_S * fs), step = Math.trunc(BREATH_STEP_S * fs);
  const out: Breath[] = [];
  for (let i = 0; i < grid.length - n; i += step) {
    let quiet = true;
    for (let k = i; k < i + n; k++) { const a = activity[k]; if (Number.isNaN(a) || a > thr * 0.5) { quiet = false; break; } }
    if (!quiet) continue;
    const est: [string, number, number][] = [];
    for (const [name, data] of sources) {
      const seg = data.map((ax) => ax.slice(i, i + n));
      if (seg.some((ax) => ax.some(Number.isNaN))) continue;
      const filt = seg.map((ax) => { const m = mean(ax); return sosfiltfilt(sos, ax.map((v) => v - m)); });
      const [r, q] = autocorrRate(principalComponent(filt), fs);
      if (!Number.isNaN(r)) est.push([name, r, q]);
    }
    if (!est.length) continue;
    let [best, rate, quality] = est.reduce((a, b) => (b[2] > a[2] ? b : a));
    if (est.length === 2) {
      const [[, r1, q1], [, r2, q2]] = est;
      if (Math.abs(r1 - r2) <= 2) { rate = (r1 * q1 + r2 * q2) / (q1 + q2); quality = Math.max(q1, q2); best = "both"; }
    }
    out.push({ t: grid[i + (n >> 1)], rate, quality, source: best });
  }
  if (!out.length) return out;
  const trend = rollingMedian(out.map((b) => (b.quality >= BREATH_MIN_QUALITY ? b.rate : NaN)), 5, 2);
  out.forEach((b, i) => { b.smooth = trend[i]; if (Math.abs(b.rate - trend[i]) > 3) b.quality *= 0.5; });
  return out;
}

interface CvhrPeak { t: number; rise: number; withMovement: boolean }
interface CvhrEpisode { start_ms: number; end_ms: number; cycles: number; mean_cycle_s: number; cycle_regularity_cv: number; mean_rise_bpm: number; share_with_movement: number }

function cvhrEpisodes(hr: Cols, events: MoveEvent[]): { episodes: CvhrEpisode[]; peaks: CvhrPeak[] } {
  const none = { episodes: [], peaks: [] };
  if (hr.bpm.length < 600) return none;
  const t0 = hr.epoch_ms[0], t1 = hr.epoch_ms[hr.epoch_ms.length - 1];
  const t = new Float64Array(Math.ceil((t1 - t0) / 1000)).map((_, i) => t0 + i * 1000);
  const bpm = interp(t, hr.epoch_ms, hr.bpm);
  for (let i = 0; i + 1 < hr.epoch_ms.length; i++) {
    const a = hr.epoch_ms[i], b = hr.epoch_ms[i + 1];
    if (b - a > 5000) for (let k = Math.max(0, Math.floor((a - t0) / 1000)); k < t.length && t[k] < b; k++) if (t[k] > a) bpm[k] = NaN;
  }
  const rm = rollingMedian(bpm, 180, 60);
  const detr = bpm.map((v, i) => { const d = v - rm[i]; return Number.isNaN(d) ? 0 : d; });
  const { peaks, prominences } = findPeaks(detr, { prominence: CVHR_MIN_RISE_BPM, distance: 15, wlen: 40 });
  if (!peaks.length) return none;
  const longMv = events.filter((e) => e.end_ms - e.start_ms > 30000);
  const pk: CvhrPeak[] = [];
  peaks.forEach((p, i) => {
    const x = t[p];
    if (longMv.some((e) => e.start_ms - 30000 <= x && e.end_ms + 30000 >= x)) return;
    pk.push({ t: x, rise: prominences[i], withMovement: events.some((e) => e.start_ms - 10000 <= x && e.end_ms + 10000 >= x) });
  });
  if (!pk.length) return none;
  const chains: number[][] = [];
  let chain = [0];
  for (let j = 1; j < pk.length; j++) {
    const d = (pk[j].t - pk[j - 1].t) / 1000;
    if (d >= CVHR_CYCLE_S[0] && d <= CVHR_CYCLE_S[1]) { chain.push(j); continue; }
    chains.push(chain); chain = [j];
  }
  chains.push(chain);
  const episodes = chains.filter((c) => c.length >= CVHR_MIN_CYCLES).map((c) => {
    const sub = c.map((j) => pk[j]);
    const cyc = sub.slice(1).map((s, k) => (s.t - sub[k].t) / 1000);
    return { start_ms: sub[0].t, end_ms: sub[sub.length - 1].t, cycles: c.length, mean_cycle_s: mean(cyc),
      cycle_regularity_cv: std(cyc, 0) / mean(cyc), mean_rise_bpm: mean(sub.map((s) => s.rise)),
      share_with_movement: mean(sub.map((s) => (s.withMovement ? 1 : 0))) };
  });
  return { episodes, peaks: pk };
}

function batteryDrain(session: string): [number, number, number] | null {
  const bat = readEvents(session).filter((e) => e.event.startsWith("battery "));
  if (bat.length < 2) return null;
  const a = Number(bat[0].event.split(/\s+/)[1]), b = Number(bat[bat.length - 1].event.split(/\s+/)[1]);
  const hours = (bat[bat.length - 1].t - bat[0].t) / 3.6e6;
  return [a, b, (a - b) / Math.max(hours, 1e-9)];
}

function perMinute(grid: Float64Array, activity: Float64Array, events: MoveEvent[], hr: Cols, breath: Breath[], cvhr: CvhrEpisode[]): F.Minute[] {
  const rows = new Map<number, F.Minute & { _a: number[] }>();
  for (let i = 0; i < grid.length; i++) {
    const m = Math.floor(grid[i] / MIN) * MIN;
    let r = rows.get(m);
    if (!r) {
      r = { minute: m, activity_mean: NaN, movement_events: 0, hr_mean: NaN, hr_min: NaN, hr_max: NaN, breaths_per_min: NaN, cvhr_episode: false, _a: [] };
      rows.set(m, r);
    }
    r._a.push(activity[i]);
  }
  for (const e of events) { const r = rows.get(Math.floor(e.start_ms / MIN) * MIN); if (r) r.movement_events++; }
  const hrBy = new Map<number, number[]>();
  for (let i = 0; i < hr.bpm.length; i++) { const m = Math.floor(hr.epoch_ms[i] / MIN) * MIN; (hrBy.get(m) ?? hrBy.set(m, []).get(m)!).push(hr.bpm[i]); }
  const brBy = new Map<number, number[]>();
  for (const b of breath) if (b.quality >= BREATH_MIN_QUALITY) { const m = Math.floor(b.t / MIN) * MIN; (brBy.get(m) ?? brBy.set(m, []).get(m)!).push(b.rate); }
  const out: F.Minute[] = [];
  for (const r of [...rows.values()].sort((a, b) => a.minute - b.minute)) {
    r.activity_mean = mean(r._a);
    const h = hrBy.get(r.minute);
    if (h) { r.hr_mean = mean(h); r.hr_min = min(h); r.hr_max = max(h); }
    const br = brBy.get(r.minute);
    if (br) r.breaths_per_min = mean(br);
    r.cvhr_episode = cvhr.some((e) => r.minute >= e.start_ms - 60000 && r.minute <= e.end_ms);
    const { _a, ...rest } = r;
    out.push(rest);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const session = args.find((a, i) => !a.startsWith("--") && !["--fitbit", "--fs", "--time-zone"].includes(args[i - 1]));
  if (!session) { console.error("Usage: tsx src/analyze.ts <session> [--fitbit file] [--time-zone IANA-name]"); process.exit(2); }
  const fs = Number(argValue(args, "--fs") ?? 25);
  const zone = sessionTimeZone(session, argValue(args, "--time-zone"));

  const { acc, gyro, hr } = load(session);
  const step = 1000 / fs;
  const g0 = acc.epoch_ms[0], g1 = acc.epoch_ms[acc.epoch_ms.length - 1];
  const grid = Float64Array.from({ length: Math.ceil((g1 - g0) / step) }, (_, i) => g0 + i * step);
  const xyz = resample(acc, grid);
  const sources: [string, Xyz][] = [["accel", xyz]];
  if (gyro && gyro.epoch_ms.length > 100) sources.push(["gyro", resample(gyro, grid)]);
  const { events, activity, thr } = movementEvents(grid, xyz, fs);
  hrResponse(events, hr);
  const breath = breathingEstimates(grid, sources, activity, thr, fs);
  const { episodes: cvhr, peaks: cvhrPeaks } = cvhrEpisodes(hr, events);
  let minutes = perMinute(grid, activity, events, hr, breath, cvhr);

  const exp = F.findExport(session, argValue(args, "--fitbit"));
  let fb: F.Fb | null = null, spo2Eps: F.Episode[] | null = null;
  const moveStarts = events.map((e) => e.start_ms);
  if (exp) {
    fb = F.load(exp.data, zone);
    minutes = F.annotate(minutes, fb, F.wristPose(acc as { epoch_ms: Float64Array; x: Float64Array; y: Float64Array; z: Float64Array }));
    spo2Eps = F.lowSpo2Episodes(minutes, moveStarts);
  }

  const hours = (grid[grid.length - 1] - grid[0]) / 3.6e6;
  const gapS = xyz[0].reduce((s, v) => s + (Number.isNaN(v) ? 1 : 0), 0) / fs;
  const good = breath.filter((b) => b.quality >= BREATH_MIN_QUALITY);
  const bat = batteryDrain(session);
  const lines = [
    `Recording: ${f(hours, 2)} h, data gaps: ${f(gapS / 60, 1)} min`,
    ...(bat ? [`Battery: ${f(bat[0])} % → ${f(bat[1])} % (${f(bat[2], 1)} %/h, 8 h ≈ ${f(bat[2] * 8)} %)`] : []),
    `Movement events: ${events.length} (${f(events.length / Math.max(hours, 1e-9), 1)}/h)`,
  ];
  if (events.length) {
    lines.push(`  of which posture changes (>30°): ${events.filter((e) => e.orientation_change_deg > 30).length}`,
      `  mean duration: ${f(mean(events.map((e) => e.duration_s)), 1)} s`);
    if (hr.bpm.length) lines.push(`  mean HR response: +${f(mean(events.map((e) => e.hr_delta ?? NaN)), 1)} bpm`);
  }
  if (hr.bpm.length) lines.push(`Heart rate: min ${f(min(hr.bpm))}, median ${f(median(hr.bpm))}, max ${f(max(hr.bpm))} bpm (${hr.bpm.length} values)`);
  const src = new Map<string, number>();
  for (const b of good) src.set(b.source, (src.get(b.source) ?? 0) + 1);
  lines.push(`Breathing rate: ${good.length} of ${breath.length} quiet windows with quality ≥${BREATH_MIN_QUALITY}` +
    (good.length ? `, median ${f(median(good.map((b) => b.rate)), 1)}/min, source: ` +
      [...src.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") : ""));
  if (cvhr.length) {
    const mins = cvhr.reduce((s, e) => s + e.end_ms - e.start_ms, 0) / 60000;
    lines.push(`Periodic HR spike episodes: ${cvhr.length} (${f(mins)} min, ${f(cvhr.reduce((s, e) => s + e.cycles, 0) / Math.max(hours, 1e-9), 1)} cycles/h)`,
      `  mean cycle ${f(mean(cvhr.map((e) => e.mean_cycle_s)))} s, rise ${f(mean(cvhr.map((e) => e.mean_rise_bpm)), 1)} bpm, with movement: ${f(mean(cvhr.map((e) => e.share_with_movement)) * 100)} %`,
      "  Note: the pattern fits sleep-disordered breathing but is no proof.");
  } else lines.push("Periodic HR spike episodes: none");
  if (fb && exp) {
    lines.push(`(Fitbit export: ${basename(exp.path)})`, ...F.summaryLines(fb, minutes, breath, moveStarts, BREATH_MIN_QUALITY).slice(1));
    for (const e of spo2Eps ?? []) {
      lines.push(`  SpO2 < ${F.LOW_SPO2} %: ${hm(e.start, zone)}–${hm(e.end, zone)} (${e.pattern}, ${e.minutes} low min, longest run ${e.longest_run_minutes} min, min ${f(e.spo2_min, 1)} %, `
        + `arm pose ±${f(e.max_pose_change_deg)}°, stage ${e.stage ?? "None"}) → ${e.verdict}`);
    }
    if (spo2Eps?.length) lines.push("  Note: watch SpO2 at the wrist is error-prone. If this repeats, check with a finger pulse oximeter.");
  }
  const summary = lines.join("\n");
  console.log(summary);

  writeFileSync(join(session, "summary.txt"), summary + "\n", "utf8");
  const evCols = ["start_ms", "end_ms", "duration_s", "peak_activity", "orientation_change_deg", ...(hr.bpm.length ? ["hr_before", "hr_peak_after", "hr_delta"] : [])];
  writeCsv(join(session, "movement_events.csv"), evCols, events.map((e) => evCols.map((c) => (e as unknown as Record<string, number>)[c])));
  writeCsv(join(session, "breathing.csv"), ["epoch_ms", "breaths_per_min", "quality", "source", "breaths_per_min_smooth"],
    breath.map((b) => [b.t, b.rate, b.quality, b.source, b.smooth]));
  writeCsv(join(session, "cvhr_episodes.csv"), ["start_ms", "end_ms", "cycles", "mean_cycle_s", "cycle_regularity_cv", "mean_rise_bpm", "share_with_movement"],
    cvhr.map((e) => [e.start_ms, e.end_ms, e.cycles, e.mean_cycle_s, e.cycle_regularity_cv, e.mean_rise_bpm, e.share_with_movement]));
  writeCsv(join(session, "cvhr_peaks.csv"), ["epoch_ms", "rise_bpm", "with_movement"], cvhrPeaks.map((p) => [p.t, p.rise, p.withMovement]));
  const mCols = ["activity_mean", "movement_events", "hr_mean", "hr_min", "hr_max", "breaths_per_min", "cvhr_episode",
    ...(fb ? ["stage", "fitbit_hr", "spo2", "hrv", "x", "y", "z", "pose_change_deg"] : [])];
  writeCsv(join(session, "per_minute.csv"), ["minute", ...mCols],
    minutes.map((m) => [isoLocal(m.minute, zone), ...mCols.map((c) => (m as unknown as Record<string, number | string | boolean>)[c])]));
  if (spo2Eps) {
    writeCsv(join(session, "spo2_episodes.csv"), ["start", "end", "minutes", "spo2_min", "spo2_mean", "max_pose_change_deg", "ends_with_movement", "hr_rise_bpm", "stage", "verdict", "pattern", "longest_run_minutes"],
      spo2Eps.map((e) => [isoLocal(e.start, zone), isoLocal(e.end, zone), e.minutes, e.spo2_min, e.spo2_mean, e.max_pose_change_deg, e.ends_with_movement, e.hr_rise_bpm, e.stage, e.verdict, e.pattern, e.longest_run_minutes]));
  }
}

if (process.argv[1]?.endsWith("analyze.ts")) main();
