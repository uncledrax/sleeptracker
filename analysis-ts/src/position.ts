/**
 * Sleep position from the watch accelerometer, calibrated per person
 * (TypeScript version of legacy/python/position.py, same model file and outputs).
 *
 *     npx tsx src/position.ts calibrate <session> [<session> ...] [--model pose_model.json] [--wrist left|right]
 *     npx tsx src/position.ts classify  <session> [--model pose_model.json] [--plot]
 *     npx tsx src/position.ts validate  <session> --phone <folder|csv> [--model ...] [--offset-s N] [--plot]
 *
 * The model defaults to sessions/pose_model.json (personal calibration, not committed).
 * Writes positions.csv, position_summary.txt, position_validation.csv/.txt like the Python version.
 * --plot writes an SVG (positions.svg / position_validation.svg) instead of matplotlib's PNG.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadSession, movementEvents, resample, type MoveEvent } from "./analyze.ts";
import { argValue, sessionTimeZone, timestampToEpoch, f, hm, hms, readEvents, readNumericCsv, sortBy, writeCsv } from "./lib/io.ts";
import { mean, median, std } from "./lib/stats.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS = ["back", "left", "right", "stomach"];
const POSE_SKIP_S = 5, POSE_HOLD_S = 25;  // template window after the tap (watch buzzes at 25 s)
const POSE_MAX_SPREAD_DEG = 12;           // wrist moved during the hold -> template discarded
const MAX_ANGLE_DEG = 35;                 // farther from every template -> "unknown"
const MIN_MARGIN_DEG = 8;                 // closer than this to a second position -> "uncertain"
const MIN_SEGMENT_S = 20;
const EPOCH_S = 30;                       // validation resolution
const CALIB_EXCLUDE_S = 60;               // validation ignores the calibration phase (trivially right)
// phone on the sternum, screen facing out, top edge towards the head (Android axes)
const PHONE_AXES: Record<string, Vec> = { back: [0, 0, 1], stomach: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], upright: [0, 1, 0] };

type Vec = [number, number, number];
type Cols = Record<string, Float64Array>;
interface Template { label: string; vector: number[]; epoch_ms?: number; source?: string; spread_deg?: number }
interface Model { version: number; wrist: string; templates: Template[] }
interface Segment {
  start_ms: number; end_ms: number; x: number; y: number; z: number;
  position: string; angle_deg: number; margin_deg: number; uncertain: boolean; minutes: number;
}
interface Marker { epoch_ms: number; label: string }

// ---------------------------------------------------------------- helpers

const unit = (v: ArrayLike<number>): Vec => {
  const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) + 1e-12;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const angleDeg = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const u = unit(a), w = unit(b);
  return (Math.acos(Math.min(1, Math.max(-1, u[0] * w[0] + u[1] * w[1] + u[2] * w[2]))) * 180) / Math.PI;
};
/** numpy/pandas round(): half to even on the scaled value. */
const round = (v: number, d: number) => {
  const s = v * 10 ** d, r = Math.round(s);
  return (Math.abs(s % 1) === 0.5 ? 2 * Math.round(s / 2) : r) / 10 ** d;
};
/** Python round(float, d): correctly rounded decimal. */
const pyRound = (v: number, d: number) => Number(f(v, d));
/** np.percentile, linear interpolation. */
function percentile(a: number[], q: number) {
  const v = Float64Array.from(a).sort();
  const pos = ((v.length - 1) * q) / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const pad = (s: string, w: number) => s.padEnd(w);
const rpad = (s: string, w: number) => s.padStart(w);
/** Column median of the rows without NaN. */
function rowMedian(rows: Vec[]): Vec {
  return [0, 1, 2].map((k) => median(rows.map((r) => r[k]))) as Vec;
}
function rowsBetween(t: ArrayLike<number>, xyz: Float64Array[], a: number, b: number, endInclusive: boolean): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= a && (endInclusive ? t[i] <= b : t[i] < b)) {
      const r: Vec = [xyz[0][i], xyz[1][i], xyz[2][i]];
      if (!r.some(Number.isNaN)) out.push(r);
    }
  }
  return out;
}

/** Minimal CSV reader with quoted fields; returns header + string rows. */
function readCsv(path: string): { header: string[]; rows: string[][] } {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length);
  const split = (l: string) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  return { header: split(lines[0] ?? ""), rows: lines.slice(1).map(split) };
}

// ---------------------------------------------------------------- calibration

function poseMarkers(session: string): Marker[] {
  return readEvents(session).filter((e) => e.event.startsWith("pose "))
    .map((e) => ({ epoch_ms: e.t, label: e.event.split(/\s+/)[1] }));
}

/** One template per tap: median gravity direction 5–25 s after it, if the wrist stayed still. */
function templatesFrom(markers: Marker[], t: ArrayLike<number>, xyz: Float64Array[], source: string) {
  const out: Template[] = [], rejected: [string, number, string][] = [];
  for (const m of markers) {
    const seg = rowsBetween(t, xyz, m.epoch_ms + POSE_SKIP_S * 1000, m.epoch_ms + POSE_HOLD_S * 1000, true);
    if (seg.length < 50) { rejected.push([m.label, m.epoch_ms, "no data"]); continue; }
    const g = unit(rowMedian(seg));
    const spread = percentile(seg.map((r) => angleDeg(r, g)), 90);
    if (spread > POSE_MAX_SPREAD_DEG) { rejected.push([m.label, m.epoch_ms, `moved (${f(spread)}°)`]); continue; }
    out.push({ label: m.label, vector: g.map((c) => pyRound(c, 4)), epoch_ms: Math.trunc(m.epoch_ms), source, spread_deg: pyRound(spread, 1) });
  }
  return { templates: out, rejected };
}

function loadModel(path: string): Model {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, wrist: "left", templates: [] };
}

function watchTemplates(session: string) {
  const acc = sortBy(readNumericCsv(join(session, "accel.csv"), ["epoch_ms", "x", "y", "z"]), "epoch_ms");
  return templatesFrom(poseMarkers(session), acc.epoch_ms, [acc.x, acc.y, acc.z], basename(session));
}

const key = (t: Template) => `${t.source}|${t.epoch_ms}`;
const labelsOf = (T: Template[]) => [...new Set(T.map((t) => t.label))].sort();

function cmdCalibrate(sessions: string[], modelPath: string, wrist: string) {
  const model = loadModel(modelPath);
  const have = new Set(model.templates.map(key));
  for (const s of sessions) {
    const { templates, rejected } = watchTemplates(s);
    for (const [lab, ms, why] of rejected) console.log(`  ${basename(s)} ${hms(ms, sessionTimeZone(s))} ${lab}: discarded, ${why}`);
    const added = templates.filter((t) => !have.has(key(t)));
    model.templates.push(...added);
    console.log(`${basename(s)}: ${added.length} new templates`);
  }
  model.wrist = wrist;
  writeFileSync(modelPath, JSON.stringify(model, null, 1));
  printModel(model);
  console.log(`Model: ${modelPath}`);
}

function printModel(model: Model) {
  const T = model.templates;
  for (const lab of labelsOf(T)) console.log(`  ${pad(lab, 8)} ${T.filter((t) => t.label === lab).length} templates`);
  const missing = LABELS.filter((l) => !T.some((t) => t.label === l));
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
  // templates of different positions that look the same -> the watch cannot tell them apart
  for (let i = 0; i < T.length; i++) {
    for (const b of T.slice(i + 1)) {
      const a = T[i];
      if (a.label === b.label) continue;
      const d = angleDeg(a.vector, b.vector);
      if (d < MIN_MARGIN_DEG * 2) {
        console.log(`  warning: ${a.label} and ${b.label} templates only ${f(d)}° apart (arm placement looks the same in both positions)`);
      }
    }
  }
}

// ---------------------------------------------------------------- classification

/** Nearest template by angle. Returns label, angle to it, margin to the next other position. */
function classifyVectors(vecs: Vec[], templates: Template[]) {
  const labs = labelsOf(templates);
  const tv = templates.map((t) => unit(t.vector));
  return vecs.map((v) => {
    const per = labs.map((lab) => Math.min(...templates.flatMap((t, i) => (t.label === lab ? [angleDeg(v, tv[i])] : []))));
    const order = per.map((_, i) => i).sort((a, b) => per[a] - per[b] || a - b);
    const best = per[order[0]];
    const second = labs.length > 1 ? per[order[1]] : 180;
    return { label: best > MAX_ANGLE_DEG ? "unknown" : labs[order[0]], angle: best, margin: second - best };
  });
}

function stillSegments(session: string, fs = 25) {
  const { acc } = loadSession(session);
  const step = 1000 / fs;
  const g0 = acc.epoch_ms[0], g1 = acc.epoch_ms[acc.epoch_ms.length - 1];
  const grid = Float64Array.from({ length: Math.ceil((g1 - g0) / step) }, (_, i) => g0 + i * step);
  const xyz = resample(acc, grid);
  const { events } = movementEvents(grid, xyz, fs);
  const bounds = [grid[0]];
  for (const e of events) bounds.push(e.start_ms, e.end_ms);
  bounds.push(grid[grid.length - 1]);
  const rows: { start_ms: number; end_ms: number; v: Vec }[] = [];
  for (let k = 0; k + 1 < bounds.length; k += 2) {
    const a = bounds[k], b = bounds[k + 1];
    if ((b - a) / 1000 < MIN_SEGMENT_S) continue;
    const seg = rowsBetween(grid, xyz, a, b, false);
    if (seg.length < fs * 5) continue;
    rows.push({ start_ms: a, end_ms: b, v: unit(rowMedian(seg)) });
  }
  return { rows, events };
}

function classifySession(session: string, modelPath: string) {
  const model = loadModel(modelPath);
  const own = watchTemplates(session).templates;
  const have = new Set(model.templates.map(key));
  const templates = [...model.templates, ...own.filter((t) => !have.has(key(t)))];
  if (labelsOf(templates).length < 2) {
    console.error("Fewer than 2 calibrated positions. Calibrate first (see README, section 11).");
    process.exit(1);
  }
  const { rows, events } = stillSegments(session);
  const cls = classifyVectors(rows.map((r) => r.v), templates);
  const seg: Segment[] = rows.map((r, i) => {
    const margin = round(cls[i].margin, 1);
    return {
      start_ms: r.start_ms, end_ms: r.end_ms, x: r.v[0], y: r.v[1], z: r.v[2],
      position: cls[i].label, angle_deg: round(cls[i].angle, 1), margin_deg: margin,
      uncertain: cls[i].label !== "unknown" && margin < MIN_MARGIN_DEG,
      minutes: round((r.end_ms - r.start_ms) / 60000, 2),
    };
  });
  return { seg, templates, events: events as MoveEvent[] };
}

/** Position for every minute (the one covering most of that minute). */
function perMinutePositions(seg: Segment[]): Map<number, string> {
  const best = new Map<number, [string, number]>();
  for (const s of seg) {
    for (let m = Math.floor(s.start_ms / 60000); m <= Math.floor(s.end_ms / 60000); m++) {
      const a = Math.max(s.start_ms, m * 60000), b = Math.min(s.end_ms, (m + 1) * 60000);
      if (b <= a) continue;
      const cur = best.get(m * 60000);
      if (!cur || b - a >= cur[1]) best.set(m * 60000, [s.position, b - a]);
    }
  }
  return new Map([...best].map(([k, v]) => [k, v[0]]));
}

function groupBy<T>(xs: T[], k: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) { const kk = k(x); if (!m.has(kk)) m.set(kk, []); m.get(kk)!.push(x); }
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function positionStats(session: string, seg: Segment[]): string[] {
  const lines: string[] = [];
  const total = seg.reduce((s, x) => s + x.minutes, 0);
  lines.push(`Classified still time: ${f(total / 60, 2)} h in ${seg.length} segments`);
  for (const [pos, g] of groupBy(seg, (s) => s.position)) {
    const m = g.reduce((s, x) => s + x.minutes, 0);
    lines.push(`  ${pad(pos, 8)} ${rpad(f(m / 60, 2), 5)} h (${rpad(f((m / total) * 100), 4)} %), `
      + `${g.length} segments, of which uncertain ${g.filter((x) => x.uncertain).length}`);
  }
  const pmPath = join(session, "per_minute.csv");
  if (!existsSync(pmPath)) {
    lines.push("(run analyze.py first for per-position heart rate / breathing / SpO2)");
    return lines;
  }
  const pmCsv = readCsv(pmPath);
  const zone = sessionTimeZone(session);
  const col = (name: string) => pmCsv.header.indexOf(name);
  const pos = perMinutePositions(seg.filter((s) => !s.uncertain));
  const pm = pmCsv.rows.map((r) => ({ r, position: pos.get(timestampToEpoch(r[0], zone)) }))
    .filter((x): x is { r: string[]; position: string } => x.position !== undefined);
  const numCol = (rows: string[][], name: string) => rows.map((r) => (r[col(name)] === "" ? NaN : Number(r[col(name)])));
  lines.push("", "Per position (uncertain segments left out):");
  const cvhrPath = join(session, "cvhr_episodes.csv");
  const cvhr = existsSync(cvhrPath) && statSync(cvhrPath).size > 1 ? readNumericCsv(cvhrPath) : null;
  for (const [p, g] of groupBy(pm, (x) => x.position)) {
    const rows = g.map((x) => x.r);
    const h = rows.length / 60;
    const parts = [rpad(f(h, 1), 4) + " h"];
    if (col("movement_events") >= 0) parts.push(`movements ${f(numCol(rows, "movement_events").reduce((s, v) => s + (Number.isNaN(v) ? 0 : v), 0) / Math.max(h, 1e-9), 1)}/h`);
    if (cvhr && cvhr.start_ms.length) {
      let n = 0, cycles = 0;
      for (let i = 0; i < cvhr.start_ms.length; i++) {
        const mid = Math.floor((cvhr.start_ms[i] + cvhr.end_ms[i]) / 2 / 60000) * 60000;
        if (pos.get(mid) === p) { n++; cycles += cvhr.cycles[i]; }
      }
      parts.push(`HR spike episodes ${n} (${f(cycles / Math.max(h, 1e-9), 1)} cycles/h)`);
    }
    const nonNan = (name: string) => col(name) >= 0 ? numCol(rows, name).filter((v) => !Number.isNaN(v)) : [];
    const br = nonNan("breaths_per_min"); if (br.length) parts.push(`breathing ${f(median(br), 1)}/min`);
    const hr = nonNan("hr_mean"); if (hr.length) parts.push(`HR ${f(median(hr))} bpm`);
    const sp = nonNan("spo2"); if (sp.length) parts.push(`SpO2 median ${f(median(sp), 1)} %, <90 %: ${sp.filter((v) => v < 90).length} min`);
    if (col("stage") >= 0) {
      const st = rows.map((r) => r[col("stage")]).filter((s) => s !== "");
      if (st.length) {
        const cnt = new Map<string, number>();
        for (const s of st) cnt.set(s, (cnt.get(s) ?? 0) + 1);
        parts.push("stages " + [...cnt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${f((v / st.length) * 100)}%`).join(" "));
      }
    }
    lines.push(`  ${pad(p, 8)} ` + parts.join(", "));
  }
  lines.push("Note: a position is only as good as the calibration; check it with "
    + "`position.py validate` (phone on the chest) before drawing conclusions.");
  return lines;
}

const SEG_COLS = ["start_ms", "end_ms", "x", "y", "z", "position", "angle_deg", "margin_deg", "uncertain", "minutes"] as const;

function cmdClassify(session: string, modelPath: string, plot: boolean) {
  const { seg, templates } = classifySession(session, modelPath);
  const lines = [`Templates: ${templates.length} (` + labelsOf(templates).map((l) => `${l} ${templates.filter((t) => t.label === l).length}`).join(", ") + ")"];
  lines.push(...positionStats(session, seg));
  const text = lines.join("\n");
  console.log(text);
  writeFileSync(join(session, "position_summary.txt"), text + "\n", "utf8");
  writeCsv(join(session, "positions.csv"), [...SEG_COLS], seg.map((s) => SEG_COLS.map((c) => s[c])));
  if (plot) plotPositions(join(session, "positions.svg"), [["watch", seg]], sessionTimeZone(session));
}

// ---------------------------------------------------------------- phone reference

function readXyzCsv(path: string): Cols {
  const { header, rows } = readCsv(path);
  const cols = new Map(header.map((c, i) => [c.toLowerCase().trim(), i]));
  const tName = ["epoch_ms", "time", "timestamp", "epoch", "t"].find((c) => cols.has(c));
  const ti = tName ? cols.get(tName)! : 0;
  if (!["x", "y", "z"].every((c) => cols.has(c))) { console.error(`${path}: needs columns x, y, z`); process.exit(1); }
  const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? NaN : Number(s));
  const t = rows.map((r) => num(r[ti]));
  const med = median(t);
  const scale = med > 1e17 ? 1e-6 : med > 1e14 ? 1e-3 : med > 1e11 ? 1 : 1000;
  const recs = rows.map((r, i) => [t[i] * scale, num(r[cols.get("x")!]), num(r[cols.get("y")!]), num(r[cols.get("z")!])])
    .filter((v) => !v.some(Number.isNaN)).sort((a, b) => a[0] - b[0]);
  return { epoch_ms: Float64Array.from(recs, (r) => r[0]), x: Float64Array.from(recs, (r) => r[1]),
    y: Float64Array.from(recs, (r) => r[2]), z: Float64Array.from(recs, (r) => r[3]) };
}

/** Returns [orientation data, activity data]; both epoch_ms,x,y,z in m/s². */
function loadPhone(path: string): [Cols, Cols] {
  if (statSync(path).isFile()) { const d = readXyzCsv(path); return [d, d]; }
  const files = new Map(readdirSync(path).map((n) => [n.toLowerCase(), join(path, n)]));
  const pick = (names: string[]) => names.map((n) => files.get(n)).find(Boolean);
  const grav = pick(["gravity.csv", "totalacceleration.csv", "accelerometer.csv", "accel.csv"]);
  if (!grav) { console.error(`${path}: no Gravity.csv / TotalAcceleration.csv / Accelerometer.csv`); process.exit(1); }
  const act = pick(["totalacceleration.csv", "accelerometer.csv", "accel.csv"]) ?? grav;
  const g = readXyzCsv(grav), a = readXyzCsv(act);
  if (median(Array.from(g.x, (_, i) => Math.hypot(g.x[i], g.y[i], g.z[i]))) < 5) {
    console.error(`${basename(grav)} has gravity removed; export Gravity or TotalAcceleration as well`);
    process.exit(1);
  }
  return [g, a];
}

function activity1hz(df: Cols, t0: number, t1: number): Float64Array {
  const n = Math.trunc(Math.floor((t1 - t0) / 1000));
  const groups: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < df.epoch_ms.length; i++) {
    const s = Math.floor((df.epoch_ms[i] - t0) / 1000);
    if (s >= 0 && s < n) groups[s].push(Math.hypot(df.x[i], df.y[i], df.z[i]));
  }
  return Float64Array.from(groups, (g) => { const v = std(g, 1); return Number.isNaN(v) ? 0 : v; });
}

/** Lag (s) to add to phone times so roll-overs line up. 0 if nothing clear. */
function estimateOffsetS(watch: Cols, phone: Cols, maxLag = 120): [number, number] {
  const last = (a: Float64Array) => a[a.length - 1];
  const t0 = Math.max(watch.epoch_ms[0], phone.epoch_ms[0]);
  const t1 = Math.min(last(watch.epoch_ms), last(phone.epoch_ms));
  if (t1 - t0 < 600_000) return [0, 0];
  const z = (a: Float64Array) => {
    const l = a.map((v) => Math.log1p(v * 10));
    const m = mean(l), s = std(l, 0);
    return l.map((v) => (v - m) / (s + 1e-9));
  };
  const w = z(activity1hz(watch, t0, t1)), p = z(activity1hz(phone, t0, t1));
  let best = 0, bestC = -1;
  const cs: number[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const a = lag >= 0 ? w.subarray(lag) : w.subarray(0, w.length + lag);
    const b = lag >= 0 ? p.subarray(0, p.length - lag) : p.subarray(-lag);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    const c = s / a.length;
    cs.push(c);
    if (c > bestC) { best = lag; bestC = c; }
  }
  // only trust a clear peak
  return bestC > 0.15 && bestC > median(cs) + 2 * std(cs, 0) ? [best, bestC] : [0, bestC];
}

function epochVectors(df: Cols, t0: number, t1: number): Map<number, Vec> {
  const n = Math.floor((t1 - t0) / (EPOCH_S * 1000));
  const groups: Vec[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < df.epoch_ms.length; i++) {
    const e = Math.floor((df.epoch_ms[i] - t0) / (EPOCH_S * 1000));
    if (e >= 0 && e < n) groups[e].push([df.x[i], df.y[i], df.z[i]]);
  }
  const out = new Map<number, Vec>();
  groups.forEach((g, e) => { if (g.length) { const v = rowMedian(g); if (!v.some(Number.isNaN)) out.set(e, v); } });
  return out;
}

/** pandas DataFrame.to_string() of a crosstab with row and column axis names. */
function crosstab(truth: string[], watch: string[]): string {
  const rows = [...new Set(truth)].sort(), cols = [...new Set(watch)].sort();
  const cnt = rows.map((r) => cols.map((c) => truth.filter((t, i) => t === r && watch[i] === c).length));
  const iw = Math.max("torso (phone)".length, "watch".length, ...rows.map((r) => r.length));
  const cw = cols.map((c, j) => Math.max(c.length, ...cnt.map((r) => String(r[j]).length)));
  const head = pad("watch", iw) + cols.map((c, j) => "  " + rpad(c, cw[j])).join("");
  const sub = pad("torso (phone)", iw) + cols.map((_, j) => "  " + " ".repeat(cw[j])).join("");
  return [head, sub, ...rows.map((r, i) => pad(r, iw) + cnt[i].map((v, j) => "  " + rpad(String(v), cw[j])).join(""))].join("\n");
}

function cmdValidate(session: string, phonePath: string, modelPath: string, offsetArg: string | undefined, plot: boolean) {
  const { seg } = classifySession(session, modelPath);
  const watch = sortBy(readNumericCsv(join(session, "accel.csv"), ["epoch_ms", "x", "y", "z"]), "epoch_ms");
  let [pg, pa] = loadPhone(phonePath);
  let off: number;
  if (offsetArg === undefined) {
    const [o, c] = estimateOffsetS(watch, pa);
    off = o;
    console.log(`Clock offset phone→watch: ${off >= 0 ? "+" : ""}${off} s (correlation ${f(c, 2)})`
      + (off ? "" : " – using 0, pass --offset-s if you know it"));
  } else off = Math.trunc(Number(offsetArg));
  pg = { ...pg, epoch_ms: pg.epoch_ms.map((t) => t + off * 1000) };

  // phone = ground truth: from the same calibration taps, else from its axes
  const markers = poseMarkers(session);
  let ptemps = templatesFrom(markers, pg.epoch_ms, [pg.x, pg.y, pg.z], "phone").templates;
  let how: string;
  if (labelsOf(ptemps).length >= 2) how = `phone templates from ${ptemps.length} calibration taps`;
  else {
    ptemps = Object.entries(PHONE_AXES).map(([label, vector]) => ({ label, vector }));
    how = "phone axes (screen facing out, top edge towards the head)";
  }
  console.log(`Ground truth: ${how}`);

  const last = (a: Float64Array) => a[a.length - 1];
  const t0 = Math.max(watch.epoch_ms[0], pg.epoch_ms[0]);
  const t1 = Math.min(last(watch.epoch_ms), last(pg.epoch_ms));
  const pv = epochVectors(pg, t0, t1);
  const idx = [...pv.keys()];
  const cls = classifyVectors(idx.map((i) => pv.get(i)!), ptemps);
  const truthMap = new Map(idx.map((i, k) => [i, cls[k].angle > 45 ? "unknown" : cls[k].label]));

  const n = Math.floor((t1 - t0) / (EPOCH_S * 1000));
  const mid = Array.from({ length: n }, (_, i) => t0 + (i + 0.5) * EPOCH_S * 1000);
  const pred = mid.map(() => "moving");
  for (const s of seg) mid.forEach((m, i) => { if (m >= s.start_ms && m < s.end_ms) pred[i] = s.uncertain ? "uncertain" : s.position; });
  const calib = mid.map((m) => markers.some((mk) => m >= mk.epoch_ms - CALIB_EXCLUDE_S * 1000 && m <= mk.epoch_ms + (POSE_HOLD_S + CALIB_EXCLUDE_S) * 1000));
  const truth = mid.map((_, i) => truthMap.get(i));

  writeCsv(join(session, "position_validation.csv"), ["epoch_ms", "truth", "watch", "calibration"],
    mid.map((m, i) => [m, truth[i], pred[i], calib[i]]));
  const ev = mid.map((_, i) => i).filter((i) => !calib[i] && LABELS.includes(truth[i] ?? ""));
  const scored = ev.filter((i) => LABELS.includes(pred[i]));
  const lines = [
    `Validation: ${f((ev.length * EPOCH_S) / 3600, 2)} h with a clear torso position (calibration phase left out), ${EPOCH_S}-s epochs`,
    `  watch gives a position in ${f((scored.length / Math.max(ev.length, 1)) * 100)} % (rest: moving / unknown / uncertain)`,
    scored.length ? `  of those correct: ${f((scored.filter((i) => truth[i] === pred[i]).length / scored.length) * 100)} %` : "  no epochs to score",
  ];
  if (scored.length) {
    const tr = scored.map((i) => truth[i]!), wa = scored.map((i) => pred[i]);
    lines.push("", "Confusion (epochs):", crosstab(tr, wa));
    // the question that matters for positional therapy: back vs. not back
    const tb = tr.map((t) => t === "back"), wb = wa.map((w) => w === "back");
    const nTb = tb.filter(Boolean).length;
    if (nTb) {
      const hit = tb.filter((t, i) => t && wb[i]).length, fa = tb.filter((t, i) => !t && wb[i]).length;
      lines.push("", `Back position: detected ${f((hit / nTb) * 100)} % of the real back time, `
        + `false alarms ${f((fa / Math.max(tr.length - nTb, 1)) * 100)} % of the rest`);
    }
    const cnt = new Map<string, number>();
    for (const t of tr) cnt.set(t, (cnt.get(t) ?? 0) + 1);
    lines.push(`Chance level (always the most common position): ${f((Math.max(...cnt.values()) / tr.length) * 100)} %`);
  }
  const text = lines.join("\n");
  console.log(text);
  writeFileSync(join(session, "position_validation.txt"), text + "\n", "utf8");
  if (plot) {
    const trk = mid.map((m, i) => ({ start_ms: m - EPOCH_S * 500, end_ms: m + EPOCH_S * 500, position: truth[i] ?? "unknown", uncertain: false }));
    plotPositions(join(session, "position_validation.svg"), [["watch", seg], ["phone (torso)", trk]], sessionTimeZone(session));
  }
}

// ---------------------------------------------------------------- plot (SVG)

const COLORS: Record<string, string> = { back: "#d62728", left: "#1f77b4", right: "#2ca02c", stomach: "#9467bd", unknown: "#d3d3d3", upright: "#000000" };
type Track = [string, { start_ms: number; end_ms: number; position: string; uncertain: boolean }[]];

function plotPositions(out: string, tracks: Track[], zone: string) {
  const all = tracks.flatMap(([, s]) => s);
  if (!all.length) { console.log("Plot: nothing to draw"); return; }
  const a = Math.min(...all.map((s) => s.start_ms)), b = Math.max(...all.map((s) => s.end_ms));
  const W = 1400, L = 110, R = 20, rowH = 40, top = 10, plotW = W - L - R;
  const x = (t: number) => L + ((t - a) / (b - a)) * plotW;
  const H = top + tracks.length * rowH + 70;
  const p: string[] = [];
  tracks.forEach(([name, segs], i) => {
    const y = top + i * rowH;
    p.push(`<text x="${L - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12">${name}</text>`);
    for (const s of segs) {
      p.push(`<rect x="${x(s.start_ms).toFixed(1)}" y="${y + 5}" width="${Math.max(0.5, x(s.end_ms) - x(s.start_ms)).toFixed(1)}" height="${rowH - 10}" fill="${COLORS[s.position] ?? COLORS.unknown}" opacity="${s.uncertain ? 0.4 : 1}"/>`);
    }
  });
  const axisY = top + tracks.length * rowH + 4;
  p.push(`<line x1="${L}" x2="${W - R}" y1="${axisY}" y2="${axisY}" stroke="#333"/>`);
  for (let t = Math.ceil(a / 3.6e6) * 3.6e6; t <= b; t += 3.6e6) {
    p.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${axisY}" y2="${axisY + 5}" stroke="#333"/><text x="${x(t)}" y="${axisY + 18}" text-anchor="middle" font-size="11">${hm(t, zone)}</text>`);
  }
  Object.entries(COLORS).forEach(([lab, c], i) => {
    const lx = L + i * 110;
    p.push(`<rect x="${lx}" y="${axisY + 32}" width="14" height="14" fill="${c}"/><text x="${lx + 20}" y="${axisY + 44}" font-size="12">${lab}</text>`);
  });
  writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif"><rect width="100%" height="100%" fill="#fff"/>${p.join("")}</svg>\n`, "utf8");
  console.log(`Plot: ${out}`);
}

// ---------------------------------------------------------------- CLI

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const valued = new Set(["--model", "--wrist", "--phone", "--offset-s"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  const model = argValue(args, "--model") ?? join(HERE, "..", "..", "sessions", "pose_model.json");
  const plot = args.includes("--plot");
  const usage = () => { console.error("Usage: tsx src/position.ts calibrate|classify|validate <session> ... (see header)"); process.exit(2); };
  if (cmd === "calibrate") {
    if (!positional.length) usage();
    const wrist = argValue(args, "--wrist") ?? "left";
    if (!["left", "right"].includes(wrist)) usage();
    cmdCalibrate(positional, model, wrist);
  } else if (cmd === "classify") {
    if (positional.length !== 1) usage();
    cmdClassify(positional[0], model, plot);
  } else if (cmd === "validate") {
    const phone = argValue(args, "--phone");
    if (positional.length !== 1 || !phone) usage();
    cmdValidate(positional[0], phone!, model, argValue(args, "--offset-s"), plot);
  } else usage();
}

if (process.argv[1]?.endsWith("position.ts")) main();
