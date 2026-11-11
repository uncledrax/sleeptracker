/**
 * Put a Fitbit export next to the per-second data (TypeScript version of legacy/python/fitbit.py).
 * Expects fitbit.json in the session folder, or a .json/.md/.txt containing the export JSON
 * (text before the first "{" is ignored).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { timestampToEpoch, f } from "./lib/io.ts";
import { corr, max, mean, median, min, std } from "./lib/stats.ts";

export const LOW_SPO2 = 90;
const LOW_SPO2_MIN_MINUTES = 5;
const ODI_DROP = 3;
const POSE_STILL_DEG = 10;
export const STAGE_ORDER = ["wake", "rem", "light", "deep"];
const MIN = 60000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface Fb {
  vitals: Json; sleep: Json;
  stages: { start: number; end: number; level: string }[];
  hr: Map<number, number>; spo2: Map<number, number>; hrv: Map<number, number>;
  room: { temperature: number; humidity: number }[];
}

export function findExport(session: string, explicit?: string): { data: Json; path: string } | null {
  const cands = explicit ? [explicit] : [join(session, "fitbit.json"),
    ...readdirSync(session).filter((p) => [".json", ".md", ".txt"].includes(extname(p).toLowerCase())).sort().map((p) => join(session, p))];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const i = text.indexOf("{");
    if (i < 0) continue;
    try {
      const data = JSON.parse(text.slice(i));
      if (data && typeof data === "object" && "fitbit" in data) return { data, path: p };
    } catch { /* next candidate */ }
  }
  return null;
}

/** Average values per local minute, key = epoch ms of the minute. */
function perMinute(rows: Json[] | undefined, col: string, zone?: string): Map<number, number> {
  const acc = new Map<number, number[]>();
  for (const r of rows ?? []) {
    const t = timestampToEpoch(r.time, zone);
    const value = r[col];
    if (!Number.isFinite(t) || value == null || value === "" || !Number.isFinite(Number(value))) continue;
    const m = Math.floor(t / MIN) * MIN;
    if (!acc.has(m)) acc.set(m, []);
    acc.get(m)!.push(Number(value));
  }
  return new Map([...acc.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, mean(v)]));
}

export function load(data: Json, zone?: string): Fb {
  const fb = data.fitbit;
  const sleep = fb.sleep ?? {};
  const stages = (sleep.timeline ?? []).map((r: Json) => {
    const start = timestampToEpoch(r.start, zone);
    return { start, end: start + r.minutes * MIN, level: r.level };
  }).filter((r: { start: number; end: number }) => Number.isFinite(r.start) && r.end > r.start);
  return {
    vitals: fb.vitals ?? {}, sleep, stages,
    hr: perMinute(fb.heartRatePerMinute, "bpm", zone),
    spo2: perMinute(fb.spo2PerMinute, "value", zone),
    hrv: perMinute(fb.hrvPer5Minutes, "value", zone),
    room: (data.tado ?? {}).readings ?? [],
  };
}

export function stageAt(stages: Fb["stages"], t: number): string | null {
  let out: string | null = null;
  for (const s of stages) if (t >= s.start && t < s.end) out = s.level;
  return out;
}

/** Gravity direction per minute (median per axis, unit vector) and angle to the previous minute. */
export function wristPose(acc: { epoch_ms: Float64Array; x: Float64Array; y: Float64Array; z: Float64Array }) {
  const by = new Map<number, number[][]>();
  for (let i = 0; i < acc.epoch_ms.length; i++) {
    const m = Math.floor(acc.epoch_ms[i] / MIN) * MIN;
    if (!by.has(m)) by.set(m, [[], [], []]);
    const b = by.get(m)!;
    b[0].push(acc.x[i]); b[1].push(acc.y[i]); b[2].push(acc.z[i]);
  }
  const keys = [...by.keys()].sort((a, b) => a - b);
  const out = new Map<number, { x: number; y: number; z: number; pose_change_deg: number }>();
  let prev: number[] | null = null;
  for (let m = keys[0]; m <= keys[keys.length - 1]; m += MIN) {
    const b = by.get(m);
    let g = [NaN, NaN, NaN];
    if (b) { g = b.map((v) => median(v)); const n = Math.hypot(g[0], g[1], g[2]); g = g.map((v) => v / n); }
    let ang = NaN;
    if (prev) {
      const cs = Math.min(1, Math.max(-1, g[0] * prev[0] + g[1] * prev[1] + g[2] * prev[2]));
      ang = (Math.acos(cs) * 180) / Math.PI;
    }
    out.set(m, { x: g[0], y: g[1], z: g[2], pose_change_deg: ang });
    prev = g;
  }
  return out;
}

export interface Minute {
  minute: number; activity_mean: number; movement_events: number; hr_mean: number; hr_min: number; hr_max: number;
  breaths_per_min: number; cvhr_episode: boolean;
  stage?: string | null; fitbit_hr?: number; spo2?: number; hrv?: number;
  x?: number; y?: number; z?: number; pose_change_deg?: number;
}

export function annotate(minutes: Minute[], fb: Fb, pose: ReturnType<typeof wristPose>) {
  const hrvKeys = [...fb.hrv.keys()];
  for (const m of minutes) {
    if (fb.stages.length) m.stage = stageAt(fb.stages, m.minute);
    m.fitbit_hr = fb.hr.get(m.minute) ?? NaN;
    m.spo2 = fb.spo2.get(m.minute) ?? NaN;
    // HRV every 5 min: forward-fill up to 4 minutes
    let h = NaN;
    for (let k = hrvKeys.length - 1; k >= 0; k--) {
      if (hrvKeys[k] <= m.minute) { if (m.minute - hrvKeys[k] <= 4 * MIN) h = fb.hrv.get(hrvKeys[k])!; break; }
    }
    m.hrv = fb.hrv.size ? h : NaN;
    const p = pose.get(m.minute);
    Object.assign(m, p ?? { x: NaN, y: NaN, z: NaN, pose_change_deg: NaN });
  }
  return minutes;
}

export interface Episode {
  start: number; end: number; minutes: number; spo2_min: number; spo2_mean: number; max_pose_change_deg: number;
  pattern: "sustained" | "intermittent"; longest_run_minutes: number;
  ends_with_movement: boolean; hr_rise_bpm: number; stage: string | null; verdict: string;
}

export function lowSpo2Episodes(m: Minute[], moveStarts: number[]): Episode[] {
  const low = m.filter((r) => (r.spo2 ?? NaN) < LOW_SPO2).map((r) => r.minute);
  const groups: number[][] = [];
  let cur: number[] = [];
  for (const t of low) {
    if (cur.length && t - cur[cur.length - 1] > 3 * MIN) { groups.push(cur); cur = []; }
    cur.push(t);
  }
  groups.push(cur);
  return groups.filter((g) => g.length >= LOW_SPO2_MIN_MINUTES).map((ep) => {
    const a = ep[0], b = ep[ep.length - 1] + MIN;
    let longestRun = 1, run = 1;
    for (let i = 1; i < ep.length; i++) {
      run = ep[i] - ep[i - 1] === MIN ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    const pattern = ep.length * MIN === b - a ? "sustained" : "intermittent";
    const seg = m.filter((r) => r.minute >= a && r.minute < b);
    const core = seg.length > 4 ? seg.slice(0, -2) : seg;
    const pc = core.length > 1 ? max(core.slice(1).map((r) => r.pose_change_deg ?? NaN)) : 0;
    const endsWithMove = moveStarts.some((t) => t >= b - 3 * MIN && t <= b + 2 * MIN);
    const hrRise = max(core.map((r) => r.hr_max)) - median(core.map((r) => r.hr_mean));
    const still = !Number.isNaN(pc) && pc < POSE_STILL_DEG;   // like Python: (nan or 0) < 10 is False
    const verdict = !Number.isFinite(hrRise) ? "insufficient HR data"
      : still && endsWithMove && hrRise < 10
      ? "probably a pose artifact (arm still, ends with movement, heart rate calm)" : "unclear";
    const stages = seg.map((r) => r.stage).filter((s): s is string => !!s);
    const counts = new Map<string, number>();
    for (const s of stages) counts.set(s, (counts.get(s) ?? 0) + 1);
    const stage = stages.length ? [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0] : null;
    const sp = seg.map((r) => r.spo2 ?? NaN);
    return { start: a, end: b, minutes: ep.length, pattern, longest_run_minutes: longestRun, spo2_min: min(sp), spo2_mean: mean(sp), max_pose_change_deg: pc,
      ends_with_movement: endsWithMove, hr_rise_bpm: hrRise, stage, verdict };
  });
}

/** Desaturations: ≥ ODI_DROP points below the median of the previous 5 min; consecutive minutes count once. */
export function odi(m: Minute[]): [number, number] {
  const s = m.filter((r) => Number.isFinite(r.spo2)).map((r) => [r.minute, r.spo2!] as const);
  if (s.length < 10) return [0, NaN];
  let n = 0, prevDrop = false;
  for (let i = 0; i < s.length; i++) {
    const base = median(s.filter(([t]) => t >= s[i][0] - 5 * MIN && t < s[i][0]).map(([, v]) => v));
    const drop = s[i][1] <= base - ODI_DROP;
    if (drop && !prevDrop) n++;
    prevDrop = drop;
  }
  return [n, n / (s.length / 60)];
}

const pyVal = (v: unknown) => (v === undefined || v === null ? "–" : String(v));

export function summaryLines(fb: Fb, m: Minute[], breath: { t: number; rate: number; quality: number }[],
  moveStarts: number[], minQuality: number): string[] {
  const lines = ["", "— Comparison with Fitbit —"];
  const v = fb.vitals, sl = fb.sleep;
  if (sl && Object.keys(sl).length) {
    lines.push(`Sleep per Fitbit: ${sl.minutesAsleep} min, efficiency ${sl.efficiency} %, `
      + `deep ${sl.deepMinutes} / light ${sl.lightMinutes} / REM ${sl.remMinutes} / awake ${sl.wakeMinutes} min`);
  }
  if (breath.length && fb.stages.length) {
    const b = breath.filter((r) => r.quality >= minQuality).map((r) => ({ ...r, stage: stageAt(fb.stages, r.t) }));
    const ref: Record<string, unknown> = { deep: v.breathingDeep, light: v.breathingLight, rem: v.breathingRem };
    const parts: string[] = [];
    for (const st of ["deep", "light", "rem"]) {
      const s = b.filter((r) => r.stage === st).map((r) => r.rate);
      if (s.length) parts.push(`${st} ${f(median(s), 1)} ±${f(std(s), 1)} (Fitbit ${pyVal(ref[st])})`);
    }
    lines.push(`Watch breathing rate per stage: ${parts.join(", ")}; overall Fitbit ${pyVal(v.breathingRate)}`);
  }
  const both = m.filter((r) => Number.isFinite(r.hr_mean) && Number.isFinite(r.fitbit_hr));
  if (both.length > 30) {
    const d = mean(both.map((r) => r.hr_mean - r.fitbit_hr!));
    lines.push(`Heart rate watch vs. Fitbit: r = ${f(corr(both.map((r) => r.hr_mean), both.map((r) => r.fitbit_hr!)), 3)}, `
      + `mean difference ${d >= 0 ? "+" : ""}${f(d, 1)} bpm`);
  }
  if (m.some((r) => r.stage) && moveStarts.length) {
    const parts: string[] = [];
    for (const s of STAGE_ORDER) {
      const mins = m.filter((r) => r.stage === s);
      if (!mins.length) continue;
      const ev = mins.reduce((a, r) => a + r.movement_events, 0);
      parts.push(`${s} ${f((ev / mins.length) * 60, 1)}/h`);
    }
    lines.push("Movement per stage: " + parts.join(", "));
  }
  const sp = m.map((r) => r.spo2 ?? NaN);
  if (sp.some((x) => Number.isFinite(x))) {
    const [n, h] = odi(m);
    lines.push(`SpO2: mean ${f(mean(sp), 1)} %, min ${f(min(sp), 1)} %, ${sp.filter((x) => x < LOW_SPO2).length} min below ${LOW_SPO2} %, `
      + `desaturations ≥${ODI_DROP} points: ${n} (${f(h, 1)}/h)`);
    if (v.hrv !== undefined && v.hrv !== null) lines.push(`HRV (Fitbit): ${v.hrv} ms, resting HR ${v.restingHeartRate}`);
  }
  if (fb.room.length) {
    const hum = mean(fb.room.map((r) => r.humidity));
    lines.push(`Room: ${f(mean(fb.room.map((r) => r.temperature)), 1)} °C, ${f(hum)} % humidity` + (hum > 60 ? " (above 60 %)" : ""));
  }
  return lines;
}

export const exportName = (p: string) => basename(p);
