/**
 * Beat-to-beat analysis of the raw pulse wave (raw_ppg.csv, button "Start + PPG").
 * TypeScript version of legacy/python/ppg.py, same rules and output files.
 *
 *     npx tsx src/ppg.ts ../sessions/<session> [--channel 6]
 *
 * Candidates, not a diagnosis. Validation only with a simultaneous ECG.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { butterBandpass, findPeaks, peakProminences, sosfiltfilt, welchBins } from "./lib/dsp.ts";
import { argValue, f, hms, readEvents, readNumericCsv, sessionTimeZone, sortBy, writeCsv } from "./lib/io.ts";
import { opticalSegments, successiveDifferences, type OpticalSegment } from "./lib/ppg_segments.ts";
import { interp, mean, median, rollingMedian, rollingStd, searchsorted, std } from "./lib/stats.ts";

const BAND: [number, number] = [0.6, 3.5];
const MOTION_THR = 0.03;
const MOTION_PAD_S = 3.0;
const MIN_CORR = 0.6;
const WIN_MED = 9;

export interface Ppg {
  t: Float64Array;
  ch: Float32Array[];
  widths: Uint16Array;
  breaks: Uint8Array;
  discarded: number;
  timingRows: number;
  timingAvailable: boolean;
  eventWidths: Uint16Array;
}

/** Read both legacy and new compact optical files. The sibling timing CSV preserves original sensor metadata. */
export function loadPpg(session: string): Ppg {
  const buf = readFileSync(join(session, "raw_ppg.csv"));
  let rows = 1;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) rows++;
  const metaPath = join(session, "session.json"), timingPath = join(session, "raw_ppg_timing.csv");
  const timing = existsSync(timingPath) ? readFileSync(timingPath) : null;
  let offset: bigint | undefined;
  if (timing && existsSync(metaPath)) {
    const ns = JSON.parse(readFileSync(metaPath, "utf8")).epochOffsetNs;
    if (typeof ns === "string" && /^-?\d+$/.test(ns)) offset = BigInt(ns);
  }
  let timingPos = timing ? timing.indexOf(10) + 1 : 0, timingRows = 0;
  const eventWidths = new Uint16Array(rows);
  const t = new Float64Array(rows), widths = new Uint16Array(rows), breaks = new Uint8Array(rows);
  const ch: Float32Array[] = [];
  const headerEnd = buf.indexOf(10);
  let pos = headerEnd < 0 ? buf.length : headerEnd + 1, r = 0, last = -Infinity;
  let discarded = 0, interrupted = false;
  while (pos < buf.length) {
    let end = buf.indexOf(10, pos);
    if (end < 0) end = buf.length;
    const line = buf.toString("latin1", pos, end).trim();
    pos = end + 1;
    if (!line) continue;
    const fields = line.split(",");
    const epochMs = fields[0] ? Number(fields[0]) : NaN;
    let ts = epochMs, physical = 0;
    if (timing && timingPos < timing.length) {
      const nl = timing.indexOf(10, timingPos);
      const end = nl < 0 ? timing.length : nl;
      const [ns, count] = timing.toString("ascii", timingPos, end).trim().split(",");
      timingPos = end + 1;
      if (offset !== undefined && /^\d+$/.test(ns) && Number.isInteger(Number(count)) && Number(count) >= Number(fields[2])) {
        const exact = offset + BigInt(ns);
        // When a recording was interrupted the companion file may end early. Always
        // check table alignment against the independent ms timestamp before using it.
        if (Number(exact / 1_000_000n) === epochMs) {
          ts += Number(exact % 1_000_000n) / 1e6;
          physical = Number(count);
        }
      }
    }
    const vals = fields[3]?.trim() ? fields[3].trim().split(/\s+/).map(Number) : [];
    if (!Number.isFinite(ts) || ts <= last || !vals.length || vals.length !== Number(fields[2]) || vals.some(v => !Number.isFinite(v))) {
      discarded++;
      interrupted = true;
      continue;
    }
    last = ts;
    while (ch.length < vals.length) ch.push(new Float32Array(rows).fill(NaN));
    t[r] = ts; widths[r] = vals.length;
    eventWidths[r] = physical;
    if (physical) timingRows++;
    breaks[r] = interrupted ? 1 : r && eventWidths[r - 1] !== physical ? 2 : 0;
    for (let k = 0; k < vals.length; k++) ch[k][r] = vals[k];
    interrupted = false;
    r++;
  }
  return { t: t.subarray(0, r), ch: ch.map(c => c.subarray(0, r)), widths: widths.subarray(0, r), breaks: breaks.subarray(0, r), discarded,
    timingRows, timingAvailable: !!timing, eventWidths: eventWidths.subarray(0, r) };
}

/** Widen movement (and unknown motion) by three elapsed seconds on each side, independent of optical sample rate. */
export function padMotion(t: Float64Array, moving: Uint8Array): Uint8Array {
  const out = moving.slice();
  let last = -Infinity, next = Infinity;
  for (let i = 0; i < t.length; i++) {
    if (moving[i]) last = t[i];
    if (t[i] - last <= MOTION_PAD_S * 1000) out[i] = 1;
  }
  for (let i = t.length - 1; i >= 0; i--) {
    if (moving[i]) next = t[i];
    if (next - t[i] <= MOTION_PAD_S * 1000) out[i] = 1;
  }
  return out;
}

export function motionMask(session: string, tMs: Float64Array): Uint8Array {
  if (!existsSync(join(session, "accel.csv"))) return new Uint8Array(tMs.length).fill(1);
  const acc = sortBy(readNumericCsv(join(session, "accel.csv"), ["epoch_ms", "x", "y", "z"]), "epoch_ms");
  if (!acc.epoch_ms.length) return new Uint8Array(tMs.length).fill(1);
  const mag = acc.x.map((x, i) => Math.hypot(x, acc.y[i], acc.z[i]));
  const at = interp(tMs, acc.epoch_ms, rollingStd(mag, 25, 5));
  const moving = new Uint8Array(tMs.length);
  const times = acc.epoch_ms;
  let k = 0;
  for (let i = 0; i < tMs.length; i++) {
    while (k + 1 < times.length && times[k + 1] <= tMs[i]) k++;
    const nearest = Math.min(Math.abs(times[k] - tMs[i]), Math.abs((times[k + 1] ?? Infinity) - tMs[i]));
    moving[i] = Number(nearest > 500 || !Number.isFinite(at[i]) || at[i] > MOTION_THR);
  }
  return padMotion(tMs, moving);
}

const SOS = (fs: number) => butterBandpass(3, BAND[0], BAND[1], fs);

/** A short hole from a trimmed trailing zero is bounded by the segment's channel eligibility check. */
export function bandpass(x: ArrayLike<number>, fs: number): Float64Array {
  const y = Float64Array.from(x);
  let prev = -1;
  for (let i = 0; i <= y.length; i++) {
    if (i < y.length && !Number.isFinite(y[i])) continue;
    if (i - prev > 1) {
      // At most four consecutive missing samples may be repaired, never across a sensor outage.
      if (i - prev > 5) throw new Error("unavailable optical channel");
      for (let k = prev + 1; k < i; k++) {
        y[k] = prev < 0 ? y[i] : i >= y.length ? y[prev] : y[prev] + ((y[i] - y[prev]) * (k - prev)) / (i - prev);
      }
    }
    prev = i;
  }
  const m = mean(y);
  for (let i = 0; i < y.length; i++) y[i] -= m;
  return sosfiltfilt(SOS(fs), y);
}

function available(x: Float32Array): boolean {
  let missing = 0, sentinels = 0;
  for (const v of x) {
    missing = Number.isFinite(v) ? 0 : missing + 1;
    if (missing > 4) return false;
    if (v < -1000) sentinels++;
  }
  return sentinels <= 0.05 * x.length && std(x, 0) > 0;
}

export function pickChannel(ch: Float32Array[], fs: number, still: Uint8Array): [number | null, number] {
  let best: number | null = null, score = 0;
  const nper = Math.trunc(fs * 8);
  const kLo = Math.ceil((0.7 * nper) / fs), kHi = Math.floor((3.0 * nper) / fs);
  ch.forEach((x, c) => {
    if (!available(x)) return;
    const yAll = bandpass(x, fs);
    const y: number[] = [];
    for (let i = 0; i < yAll.length; i++) if (still[i]) y.push(yAll[i]);
    if (y.length < fs * 20) return;
    const p = welchBins(y, nper, kLo, kHi);
    let mx = 0, sum = 0;
    for (const v of p) { sum += v; if (v > mx) mx = v; }
    const s = mx / sum;
    if (s > score) { best = c; score = s; }
  });
  return [best, score];
}

export interface Beats {
  t: number[]; amp: number[]; corr: number[]; moving: boolean[]; ibi: number[]; clean: boolean[]; ibiMed: number[]; flag: string[]; segment?: number[];
}
export interface PpgEvent {
  t: number; kind: string; ibi: number; ibiNext: number; ibiMedian: number; midWave: number; nextAmp: number;
}

export function detectBeats(y: Float64Array, fs: number) {
  const amp = rollingMedian(y.map(Math.abs), Math.trunc(2 * fs), Math.trunc(fs / 2));
  const { peaks, prominences } = findPeaks(y, { distance: Math.trunc(0.33 * fs), prominence: 1e-9 });
  const pk: number[] = [], prom: number[] = [];
  peaks.forEach((p, i) => { if (prominences[i] >= 0.8 * amp[p]) { pk.push(p); prom.push(prominences[i]); } });
  return { pk, prom };
}

export function beatCorr(y: Float64Array, pk: number[], fs: number): number[] {
  const a = Math.trunc(0.3 * fs), b = Math.trunc(0.5 * fs), L = a + b;
  const segs: Float64Array[] = [], idx: number[] = [];
  pk.forEach((p, i) => {
    if (p - a >= 0 && p + b < y.length) {
      const s = y.slice(p - a, p + b);
      const m = mean(s), sd = std(s, 0) + 1e-9;
      segs.push(s.map((v) => (v - m) / sd)); idx.push(i);
    }
  });
  const corr = new Array(pk.length).fill(NaN);
  if (segs.length > 10) {
    const tmpl = new Float64Array(L);
    const col = new Float64Array(segs.length);
    for (let k = 0; k < L; k++) { for (let j = 0; j < segs.length; j++) col[j] = segs[j][k]; tmpl[k] = median(col); }
    let nt = 0;
    for (const v of tmpl) nt += v * v;
    const norm = Math.sqrt(nt) * Math.sqrt(L);
    segs.forEach((s, j) => { let d = 0; for (let k = 0; k < L; k++) d += s[k] * tmpl[k]; corr[idx[j]] = d / norm; });
  }
  return corr;
}

/** pandas rolling(WIN_MED, center, min_periods=4).median() on a list with NaN, then ffill/bfill. */
function medFill(v: number[]): number[] {
  const m = Array.from(rollingMedian(v, WIN_MED, 4));
  let last = NaN;
  for (let i = 0; i < m.length; i++) if (Number.isNaN(m[i])) m[i] = last; else last = m[i];
  last = NaN;
  for (let i = m.length - 1; i >= 0; i--) if (Number.isNaN(m[i])) m[i] = last; else last = m[i];
  return m;
}

export function analyse(tMs: Float64Array, y: Float64Array, fs: number, moving: Uint8Array) {
  const { pk, prom } = detectBeats(y, fs);
  const corr = beatCorr(y, pk, fs);
  const n = pk.length;
  const b: Beats = {
    t: pk.map((p) => tMs[p]), amp: prom, corr, moving: pk.map((p) => !!moving[p]),
    ibi: [], clean: [], ibiMed: [], flag: new Array(n).fill(""),
  };
  b.ibi = b.t.map((t, i) => (i ? t - b.t[i - 1] : NaN));
  const good = b.moving.map((m, i) => !m && b.corr[i] >= MIN_CORR);
  b.clean = good.map((g, i) => g && i > 0 && good[i - 1] && b.ibi[i] >= 300 && b.ibi[i] <= 2500);
  const m = medFill(b.ibi.map((v, i) => (b.clean[i] ? v : NaN)));
  b.ibiMed = m;
  const ampMed = medFill(b.amp.map((v, i) => (b.clean[i] ? v : NaN)));
  const events: PpgEvent[] = [];
  for (let i = 2; i < n - 2; i++) {
    let mv = false;
    for (let k = Math.max(0, i - 4); k < Math.min(n, i + 4); k++) if (b.moving[k]) { mv = true; break; }
    if (mv || !Number.isFinite(m[i])) continue;
    const r = b.ibi[i] / m[i], rNext = b.ibi[i + 1] / m[i];
    let kind: string;
    if (r < 0.8 && rNext > 1.1 && r + rNext >= 1.75 && r + rNext <= 2.3 && b.clean[i - 1]) kind = "premature";
    else if (r >= 1.75 && r <= 2.3 && b.ibi[i - 1] / m[i] >= 0.85 && b.ibi[i - 1] / m[i] <= 1.15 &&
      b.ibi[i + 1] / m[i] >= 0.85 && b.ibi[i + 1] / m[i] <= 1.15) kind = "missed pulse";
    else continue;
    const a0 = searchsorted(tMs, b.t[i - 1] + 250), b0 = searchsorted(tMs, b.t[i] - 250);
    let mid = NaN;
    if (b0 > a0) {
      let lo = Infinity, hi = -Infinity;
      for (let k = a0; k < b0; k++) { if (y[k] < lo) lo = y[k]; if (y[k] > hi) hi = y[k]; }
      mid = (hi - lo) / (2 * ampMed[i]);
    }
    const post = b.amp[i + (kind === "premature" ? 1 : 0)] / ampMed[i];
    b.flag[i] = kind;
    events.push({ t: b.t[i], kind, ibi: b.ibi[i], ibiNext: b.ibi[i + 1], ibiMedian: m[i],
      midWave: round2(mid), nextAmp: round2(post) });
  }
  return { beats: b, events };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function hrv(b: Beats) {
  const n = b.t.length;
  const nn: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!b.clean[i] || b.flag[i] !== "") continue;
    const near = (i > 0 && b.segment?.[i - 1] === b.segment?.[i] && b.flag[i - 1] !== "") ||
      (i + 1 < n && b.segment?.[i + 1] === b.segment?.[i] && b.flag[i + 1] !== "");
    if (near) continue;
    if (!Number.isFinite(b.ibiMed[i]) || Math.abs(b.ibi[i] / b.ibiMed[i] - 1) > 0.2) continue;
    nn.push(i);
  }
  const ibis = nn.map((i) => b.ibi[i]);
  const accepted = new Set(nn);
  const d = successiveDifferences(n, i => b.ibi[i], i => accepted.has(i), i => b.segment?.[i] === b.segment?.[i - 1]);
  const sdnn = std(ibis, 1);
  const rmssd = d.length ? Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length) : NaN;
  return { nn, ibis, sdnn, rmssd, pairs: d.length };
}

export function feltMarkers(session: string): number[] {
  return readEvents(session).filter((e) => e.event === "felt").map((e) => e.t).sort((a, b) => a - b);
}

export function checkFelt(markers: number[], b: Beats, events: PpgEvent[], beforeS = 8.0, afterS = 1.0) {
  const cleanIbi = b.ibi.filter((_, i) => b.clean[i]);
  return markers.map((mk) => {
    let ref = b.ibi.filter((_, i) => b.t[i] > mk - 60000 && b.t[i] < mk - beforeS * 1000 && b.clean[i]);
    if (ref.length < 10) ref = cleanIbi;
    const med = median(ref);
    const win = b.t.map((t, i) => i).filter((i) => b.t[i] > mk - beforeS * 1000 && b.t[i] <= mk + afterS * 1000);
    const r = win.map((i) => b.ibi[i] / med);
    let found = "", dt = NaN;
    for (let i = 0; i < r.length; i++) {
      const nxt = i + 1 < r.length && b.segment?.[win[i]] === b.segment?.[win[i + 1]] ? r[i + 1] : NaN;
      if (r[i] < 0.8 && nxt > 1.1 && r[i] + nxt >= 1.75 && r[i] + nxt <= 2.3) found = "premature";
      else if (r[i] >= 1.75 && r[i] <= 2.3) found = "missed pulse";
      else if (r[i] > 1.3 || r[i] < 0.75) found = "irregular";
      if (found) { dt = (b.t[win[i]] - mk) / 1000; break; }
    }
    const auto = events.filter((e) => e.t > mk - beforeS * 1000 && e.t <= mk + afterS * 1000);
    return { t: mk, pattern: found || "none", secondsBefore: dt, auto: auto.length > 0, median: med, beats: win.length };
  });
}

interface SegmentResult extends OpticalSegment {
  channel: number | null;
  quality: number;
  cleanMs: number;
  status: string;
}

/** Reset optical filters, beat templates and intervals at every acquisition boundary. */
export function analyseRecording(data: Ppg, moving: Uint8Array, fixedChannel?: number) {
  const { t, ch, widths, breaks } = data;
  const beats: Beats = { t: [], amp: [], corr: [], moving: [], ibi: [], clean: [], ibiMed: [], flag: [], segment: [] };
  const events: PpgEvent[] = [];
  const segments: SegmentResult[] = [];
  for (const seg of opticalSegments(t, widths, breaks)) {
    const { from, end, width, fs } = seg;
    const result: SegmentResult = { ...seg, channel: null, quality: NaN, cleanMs: 0, status: "too short" };
    segments.push(result);
    if (t[end - 1] - t[from] < 20_000) continue;
    if (!Number.isFinite(fs) || fs <= BAND[1] * 2) { result.status = "sampling rate too low"; continue; }
    const channels = ch.slice(0, width).map(c => c.subarray(from, end));
    const motion = moving.subarray(from, end);
    const [c, score] = fixedChannel === undefined ? pickChannel(channels, fs, motion.map(m => Number(!m))) : [fixedChannel, NaN];
    if (c === null || !channels[c] || !available(channels[c])) {
      result.status = "no usable pulse channel"; continue;
    }
    result.channel = c; result.quality = score;
    const part = analyse(t.subarray(from, end), bandpass(channels[c], fs), fs, motion);
    const b = part.beats;
    for (let i = 0; i < b.t.length; i++) {
      beats.t.push(b.t[i]); beats.amp.push(b.amp[i]); beats.corr.push(b.corr[i]);
      beats.moving.push(b.moving[i]); beats.ibi.push(b.ibi[i]); beats.clean.push(b.clean[i]);
      beats.ibiMed.push(b.ibiMed[i]); beats.flag.push(b.flag[i]); beats.segment!.push(segments.length);
      if (b.clean[i]) result.cleanMs += b.ibi[i];
    }
    for (const e of part.events) events.push(e);
    result.status = result.cleanMs ? "analysed" : "no clean intervals";
  }
  return { beats, events, segments };
}

function main() {
  const args = process.argv.slice(2);
  const session = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--channel");
  if (!session) { console.error("Usage: tsx src/ppg.ts <session> [--channel N]"); process.exit(2); }
  const chArg = argValue(args, "--channel");

  const raw = loadPpg(session);
  const { t } = raw;
  const channel = chArg === undefined ? undefined : Number(chArg);
  if (channel !== undefined && (!Number.isInteger(channel) || channel < 0)) { console.error("Channel must be a non-negative integer."); process.exit(2); }
  const { beats, events, segments } = analyseRecording(raw, motionMask(session, t), channel);
  const { ibis, sdnn, rmssd, pairs } = hrv(beats);
  const zone = sessionTimeZone(session);
  const recordingEvents = readEvents(session);
  const startMs = recordingEvents.find(e => /^(start |ecg_test start)/.test(e.event))?.t ?? t[0];
  const stopMs = recordingEvents.slice().reverse().find(e => e.event === "stop")?.t ?? t[t.length - 1];
  const hours = Number.isFinite(stopMs - startMs) ? Math.max(0, stopMs - startMs) / 3.6e6 : 0;
  const cleanH = segments.reduce((sum, s) => sum + s.cleanMs, 0) / 3.6e6;
  const lines = [
    `PPG: ${segments.length} segments, ${f(hours * 60, 1)} min recording span, ${f(cleanH * 60, 2)} min clean beat sequence (${f(hours ? cleanH / hours * 100 : 0)}%)`,
    `Discarded malformed or non-increasing input rows: ${raw.discarded}. Channel, rate, exclusions and coverage per segment in ppg_segments.csv.`,
    raw.timingAvailable ? `Sensor timing matched ${raw.timingRows} of ${t.length} samples. Other rows use epoch_ms.` : "Timing source: legacy epoch_ms.",
    ibis.length ? `Beats: ${beats.t.length}, heart rate from intervals ${f(60000 / mean(ibis), 1)} bpm` : "Beats: too few",
    `HRV (clean NN intervals only): SDNN ${f(sdnn)} ms, RMSSD ${f(rmssd)} ms (${pairs} adjacent pairs)`,
  ];
  writeCsv(join(session, "ppg_segments.csv"),
    ["segment", "start_epoch_ms", "end_epoch_ms", "boundary", "effective_width", "event_width", "samples", "sample_hz", "channel", "quality", "clean_minutes", "status"],
    segments.map((s, i) => [i + 1, t[s.from], t[s.end - 1], s.reason, s.width, raw.eventWidths[s.from] || null, s.end - s.from, s.fs, s.channel, s.quality, s.cleanMs / 60_000, s.status]));
  if (existsSync(join(session, "hr.csv"))) {
    const hr = readNumericCsv(join(session, "hr.csv"), ["bpm", "accuracy"]);
    const ok = Array.from(hr.bpm).filter((v, i) => v > 30 && hr.accuracy[i] >= 2);
    if (ok.length && ibis.length) lines.push(`Watch heart-rate sensor in the same period: ${f(mean(ok), 1)} bpm`);
  }
  if (!events.length) lines.push("Ectopic beat candidates: none");
  else {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`Ectopic beat candidates: ${events.length} (${f(events.length / Math.max(cleanH, 1e-9))} per clean hour) – `
      + byCount.map(([k, v]) => `${k} ${v}`).join(", "));
    for (const e of events) {
      lines.push(`  ${hms(e.t, zone)} ${e.kind}: ${f(e.ibi)} → ${f(e.ibiNext)} ms (median ${f(e.ibiMedian)}), `
        + `mid wave ${pyNum(e.midWave)}, next beat ×${pyNum(e.nextAmp)}`);
    }
    lines.push("Note: candidates, not a diagnosis. 'missed pulse' can also be a missed beat.");
  }

  const markers = feltMarkers(session);
  const felt = markers.length ? checkFelt(markers, beats, events) : [];
  if (felt.length) {
    const hit = felt.filter((x) => x.pattern === "premature" || x.pattern === "missed pulse").length;
    const irr = felt.filter((x) => x.pattern === "irregular").length;
    const minutes = beats.t.length ? (beats.t[beats.t.length - 1] - beats.t[0]) / 60000 : 0;
    const chance = minutes ? 1 - Math.exp(((-events.length / Math.max(minutes, 1e-9)) * 9) / 60) : NaN;
    lines.push(`Felt: ${felt.length}× – of which ${hit} with an ectopic pattern in the 8 s before, `
      + `${irr} only irregular, ${felt.length - hit - irr} unremarkable `
      + `(chance of a random hit per window ≈ ${f(chance * 100)} %)`);
    for (const x of felt) lines.push(`  ${hms(x.t, zone)}: ${x.pattern}` + (Number.isFinite(x.secondsBefore) ? ` (${f(-x.secondsBefore, 1)} s before)` : ""));
    const autoHit = events.filter((e) => markers.some((mk) => mk > e.t - 1000 && mk < e.t + 8000)).length;
    lines.push(`Automatic candidates without a felt marker in the 8 s after: ${events.length - autoHit}`);
    writeCsv(join(session, "ppg_felt.csv"),
      ["epoch_ms", "pattern", "seconds_before_marker", "auto_candidate", "median_ibi_ms", "beats_in_window"],
      felt.map((x) => [x.t, x.pattern, x.secondsBefore, x.auto, x.median, x.beats]));
  }

  const text = lines.join("\n");
  console.log(text);
  writeFileSync(join(session, "ppg_summary.txt"), text + "\n", "utf8");
  writeCsv(join(session, "ppg_beats.csv"), ["epoch_ms", "amp", "corr", "moving", "ibi_ms", "clean", "ibi_med", "flag", "segment"],
    beats.t.map((tt, i) => [tt, beats.amp[i], beats.corr[i], beats.moving[i], beats.ibi[i], beats.clean[i], beats.ibiMed[i], beats.flag[i], beats.segment![i]]));
  writeCsv(join(session, "ppg_events.csv"),
    ["epoch_ms", "kind", "ibi_ms", "ibi_next_ms", "ibi_median_ms", "mid_wave_rel", "next_beat_amp_rel"],
    events.map((e) => [e.t, e.kind, e.ibi, e.ibiNext, e.ibiMedian, e.midWave, e.nextAmp]));
}

/** Number like Python's str(float) for rounded values: 0.5, 1.0, 0.17 */
const pyNum = (v: number) => (Number.isNaN(v) ? "nan" : Number.isInteger(v) ? v.toFixed(1) : String(v));

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ppg.ts")) main();
