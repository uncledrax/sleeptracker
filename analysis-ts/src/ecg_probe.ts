/**
 * ECG test (experimental): first look at the undocumented ECG sensors of the Pixel Watch
 * (raw_ecg.csv, raw_ecg_lead.csv from the "ECG test" button), compared with hr.csv and raw_ppg.csv.
 *
 *     npx tsx src/ecg_probe.ts ../sessions/<session>
 *
 * Prints/writes: events, sample rate, values per event, statistics per channel, lead detector history.
 * If a channel looks like an ECG: band-pass 0.5–40 Hz, R peaks, heart rate and RR intervals,
 * comparison with the heart-rate sensor and the PPG beats (via ppg.ts). Outputs ecg_summary.txt,
 * ecg_beats.csv and ecg_probe.svg (10-s snippet raw + filtered with R peaks, RR over time, lead detector).
 * The live analyzer shows the same report under "ECG test".
 *
 * Not a medical device, no diagnosis. Without the vendor's validation this only answers
 * "does a third-party app get usable raw data?".
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hrv, type Hrv } from "./lib/hrv.ts";
import { basename, join } from "node:path";
import { butterBandpass, findPeaks, sosfiltfilt } from "./lib/dsp.ts";
import { f, hms, sessionTimeZone, readEvents, writeCsv } from "./lib/io.ts";
import { mean, median, std } from "./lib/stats.ts";
import { analyseRecording, loadPpg } from "./ppg.ts";

const ECG_BAND: [number, number] = [0.5, 40];
const RR_MIN = 300, RR_MAX = 2000;
const SHAPE_MIN = 0.7;   // real beats: ~0.9; peaks picked from noise: < 0.55

// ---------- reading ----------

export interface RawFile { t: number[]; accuracy: number[]; n: number[]; vals: number[][] }

/** epoch_ms,accuracy,n,"v0 v1 …" – all rows, in file order (no de-duplication; the stats report duplicates). */
export function loadRaw(path: string): RawFile | null {
  if (!existsSync(path)) return null;
  const out: RawFile = { t: [], accuracy: [], n: [], vals: [] };
  const lines = readFileSync(path, "latin1").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c1 = line.indexOf(","), c2 = line.indexOf(",", c1 + 1), c3 = line.indexOf(",", c2 + 1);
    if (c3 < 0) continue;
    out.t.push(Number(line.slice(0, c1)));
    out.accuracy.push(Number(line.slice(c1 + 1, c2)));
    out.n.push(Number(line.slice(c2 + 1, c3)));
    out.vals.push(line.slice(c3 + 1).trim().split(/\s+/).map(Number));
  }
  return out;
}

export interface FileStats {
  events: number; durationS: number; eventRateHz: number; duplicatePct: number;
  valuesPerEvent: Record<string, number>; accuracy: Record<string, number>; firstMs: number | null; lastMs: number | null;
}

const countBy = (a: number[]) => a.reduce<Record<string, number>>((m, v) => { m[v] = (m[v] ?? 0) + 1; return m; }, {});

function fileStats(r: RawFile): FileStats {
  const n = r.t.length;
  const dt = r.t.slice(1).map((t, i) => t - r.t[i]);
  const pos = dt.filter((d) => d > 0);
  return {
    events: n,
    durationS: n > 1 ? (r.t[n - 1] - r.t[0]) / 1000 : 0,
    eventRateHz: n > 1 && r.t[n - 1] > r.t[0] ? ((n - 1) * 1000) / (r.t[n - 1] - r.t[0]) : 0,
    duplicatePct: dt.length ? (100 * (dt.length - pos.length)) / dt.length : 0,
    valuesPerEvent: countBy(r.n), accuracy: countBy(r.accuracy),
    firstMs: n ? r.t[0] : null, lastMs: n ? r.t[n - 1] : null,
  };
}

export interface ChannelStats { name: string; mean: number; std: number; min: number; max: number; unique: number }

/** One column per value position; trailing values cut off by the app were zeros, so missing = 0. */
function columns(r: RawFile): number[][] {
  const width = Math.max(0, ...r.vals.map((v) => v.length));
  return Array.from({ length: width }, (_, c) => r.vals.map((v) => (c < v.length ? v[c] : 0)));
}

function channelStats(name: string, x: number[]): ChannelStats {
  let lo = Infinity, hi = -Infinity;
  for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return { name, mean: mean(x), std: std(x, 1), min: lo, max: hi, unique: new Set(x).size };
}

// ---------- ECG detection ----------

export interface RDetect {
  fs: number; filt: Float64Array; peaks: number[]; rr: number[]; plausible: number;
  hr: number | null; looksEcg: boolean; score: number; why: string;
}

const pct = (x: ArrayLike<number>, q: number) => {
  const s = Array.from(x).filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] : NaN;
};

/**
 * Beat-shape consistency: median correlation of each beat (−150…+350 ms around the R peak, i.e. QRS + T)
 * with the average beat. Real heartbeats repeat their shape (> 0.5); peaks picked from noise do not.
 */
export function templateCorr(y: ArrayLike<number>, peaks: number[], fs: number): number {
  const a = Math.round(0.15 * fs), b = Math.round(0.35 * fs);
  const segs = peaks.filter((p) => p - a >= 0 && p + b < y.length && Number.isFinite(y[p - a]) && Number.isFinite(y[p + b]))
    .map((p) => Array.from({ length: a + b }, (_, i) => y[p - a + i]));
  if (segs.length < 4) return 0;
  const tpl = segs[0].map((_, i) => mean(segs.map((s) => s[i])));
  const corr = (u: number[], v: number[]) => {
    const mu = mean(u), mv = mean(v);
    let n = 0, du = 0, dv = 0;
    for (let i = 0; i < u.length; i++) { n += (u[i] - mu) * (v[i] - mv); du += (u[i] - mu) ** 2; dv += (v[i] - mv) ** 2; }
    return du && dv ? n / Math.sqrt(du * dv) : 0;
  };
  return median(segs.map((s) => corr(s, tpl)));
}

/**
 * Longest stretch without lead-off artefacts: 1-s windows whose spread (p95−p5) is at most 5× the median
 * window spread and that do not touch the ADC rail. At the start of the test the ECG sits at the rail
 * (±2^21) and needs a few seconds to settle; those seconds would otherwise dominate the filter and the
 * amplitude estimate. Returns [start, end) sample indices.
 */
export function stableRange(x: ArrayLike<number>, fs: number): [number, number] {
  const w = Math.max(1, Math.round(fs)), nW = Math.floor(x.length / w);
  if (nW < 3) return [0, x.length];
  let rail = 0;
  for (let i = 0; i < x.length; i++) rail = Math.max(rail, Math.abs(x[i]));
  const spread: number[] = [], railHit: boolean[] = [];
  for (let k = 0; k < nW; k++) {
    const seg = Array.from({ length: w }, (_, i) => x[k * w + i]);
    spread.push(pct(seg, 0.95) - pct(seg, 0.05));
    railHit.push(seg.filter((v) => Math.abs(v) >= rail).length >= 3);
  }
  const lim = 5 * median(spread);
  let best: [number, number] = [0, 0], start = -1;
  for (let k = 0; k <= nW; k++) {
    const ok = k < nW && spread[k] <= lim && !railHit[k];
    if (ok && start < 0) start = k;
    if (!ok && start >= 0) { if (k - start > best[1] - best[0]) best = [start, k]; start = -1; }
  }
  if (best[1] === best[0]) return [0, x.length];
  // the last window takes the remainder
  return [best[0] * w, best[1] === nW ? x.length : best[1] * w];
}

/**
 * Band-pass 0.5–40 Hz (upper edge limited to 0.45·fs) on the longest artefact-free stretch, polarity so
 * that R points up, peaks at least 0.3 s apart with a prominence of ≥ 50 % of the robust amplitude;
 * a peak within 450 ms after a beat that is less than 60 % of it is dropped (T wave).
 * "Looks like ECG": beats share their shape (templateCorr ≥ 0.7), ≥ 8 beats, ≥ 80 % of RR intervals in 300–2000 ms,
 * successive RR changes < 20 % (median). Peak indices refer to the full input.
 */
export function detectR(x: ArrayLike<number>, fs: number): RDetect {
  const empty = (why: string): RDetect => ({ fs, filt: new Float64Array(0), peaks: [], rr: [], plausible: 0, hr: null, looksEcg: false, score: 0, why });
  if (!(fs >= 50)) return empty(`sample rate ${f(fs, 1)} Hz is too low for an ECG`);
  if (x.length < fs * 4) return empty("less than 4 s of data");
  if (std(x, 0) === 0) return empty("constant signal");
  const [a, b] = stableRange(x, fs);
  if (b - a < fs * 4) return empty("less than 4 s without lead-off artefacts");
  const seg = Array.from({ length: b - a }, (_, i) => x[a + i]);
  const m = mean(seg);
  let ys: Float64Array;
  try {
    ys = sosfiltfilt(butterBandpass(2, ECG_BAND[0], Math.min(ECG_BAND[1], 0.45 * fs), fs), seg.map((v) => v - m));
  } catch (e) { return empty((e as Error).message); }
  if (Math.abs(pct(ys, 0.005)) > Math.abs(pct(ys, 0.995))) ys = ys.map((v) => -v);
  const amp = pct(ys, 0.995) - median(ys);
  if (!(amp > 0)) return empty("no amplitude after filtering");
  const raw = findPeaks(ys, { distance: Math.max(1, Math.trunc(0.3 * fs)), prominence: 0.5 * amp }).peaks;
  const tWin = 0.45 * fs, segPeaks: number[] = [];
  for (const p of raw) {
    const prev = segPeaks[segPeaks.length - 1];
    if (prev !== undefined && p - prev < tWin && ys[p] < 0.6 * ys[prev]) continue;     // T wave after R
    if (prev !== undefined && p - prev < tWin && ys[prev] < 0.6 * ys[p]) segPeaks.pop(); // previous one was the T wave
    segPeaks.push(p);
  }
  const peaks = segPeaks.map((p) => p + a);
  const y = new Float64Array(x.length).fill(NaN);
  y.set(ys, a);
  // sub-sample R timing (parabola through the peak and its neighbours): 250 Hz alone would quantise RR to 4 ms
  const refined = segPeaks.map((p) => {
    const y0 = ys[p - 1], y1 = ys[p], y2 = ys[p + 1];
    const den = y0 - 2 * y1 + y2;
    const d = p > 0 && p < ys.length - 1 && den < 0 ? (0.5 * (y0 - y2)) / den : 0;
    return p + a + Math.max(-0.5, Math.min(0.5, d));
  });
  const rr = refined.slice(1).map((p, i) => Math.round(((p - refined[i]) * 1000) / fs * 10) / 10);
  const ok = rr.filter((v) => v >= RR_MIN && v <= RR_MAX);
  const succ = ok.slice(1).map((v, i) => Math.abs(v - ok[i]) / ok[i]);
  const stable = succ.length ? median(succ) : Infinity;
  const plausibleShare = rr.length ? ok.length / rr.length : 0;
  const shape = templateCorr(ys, segPeaks, fs);
  const looksEcg = shape >= SHAPE_MIN && peaks.length >= 8 && plausibleShare >= 0.8 && stable < 0.2;
  const skipped = a > 0 || b < x.length ? ` (${f(a / fs, 1)}–${f(b / fs, 1)} s used, rest lead-off/settling)` : "";
  const why = (looksEcg ? "regular R peaks"
    : shape < SHAPE_MIN ? `beats do not repeat their shape (r = ${f(shape, 2)}; noise, counter or sequence byte)`
    : peaks.length < 8 ? `only ${peaks.length} peaks`
    : plausibleShare < 0.8 ? `${f(plausibleShare * 100)} % of intervals in ${RR_MIN}–${RR_MAX} ms`
    : `intervals too irregular (median change ${f(stable * 100)} %)`) + skipped;
  return {
    fs, filt: y, peaks, rr, plausible: ok.length, hr: ok.length >= 3 ? 60000 / median(ok) : null, looksEcg,
    score: (looksEcg ? 1000 : 0) + ok.length * plausibleShare * shape, why,
  };
}

// ---------- report ----------

export interface EcgReport {
  /** HRV of the whole test (ECG RR intervals); null without a usable ECG */
  hrv: Hrv | null;
  session: string;
  timeZone: string;
  verdict: "no_file" | "blocked" | "constant" | "ecg" | "not_ecg";
  verdictText: string;
  lines: string[];
  registration: string[];                 // ECG-related lines from events.csv (registerListener result etc.)
  ecg: FileStats | null; lead: FileStats | null;
  channels: ChannelStats[];
  best: { label: string; fs: number; beats: number; hr: number | null; looksEcg: boolean; why: string } | null;
  snippet: { t: number[]; raw: number[]; filt: number[]; peaks: number[] } | null;
  rr: { t: number[]; rr: number[] };
  hrSensor: { t: number[]; bpm: number[] };
  ppg: { t: number[]; ibi: number[]; hr: number | null; ptt: number | null; matched: number } | null;
  leadSeries: { t: number[]; v: number[] };
  leadChanges: { t: number; value: string }[];
}

interface Candidate { label: string; t0: number; fs: number; x: number[]; tOf: (i: number) => number }

/** Candidate signals: every column at the event rate, plus "packed" (all values in a row = consecutive samples). */
function candidates(r: RawFile, st: FileStats): Candidate[] {
  const out: Candidate[] = [];
  const n = r.t.length, t0 = r.t[0], span = r.t[n - 1] - t0;
  const fs = st.eventRateHz;
  columns(r).forEach((x, c) => out.push({ label: `v${c}`, t0, fs, x, tOf: (i) => t0 + (i * span) / Math.max(1, n - 1) }));
  const widths = Object.keys(st.valuesPerEvent).map(Number);
  if (widths.length === 1 && widths[0] > 1 && fs * widths[0] <= 4000) {
    const w = widths[0], flat = r.vals.flat();
    out.push({ label: `packed ×${w}`, t0, fs: fs * w, x: flat, tOf: (i) => t0 + (i * span) / Math.max(1, flat.length - 1) });
  }
  return out;
}

export function analyzeEcg(session: string): EcgReport {
  const rep: EcgReport = {
    hrv: null, session: basename(session), timeZone: sessionTimeZone(session), verdict: "no_file", verdictText: "", lines: [], registration: [],
    ecg: null, lead: null, channels: [], best: null, snippet: null,
    rr: { t: [], rr: [] }, hrSensor: { t: [], bpm: [] }, ppg: null, leadSeries: { t: [], v: [] }, leadChanges: [],
  };
  const L = rep.lines;
  try {
    rep.registration = readEvents(session)
      .filter((e) => /^(raw |raw_missing|ecg_|no_heart)/.test(e.event))
      .map((e) => `${hms(e.t, rep.timeZone)} ${e.event}`);
  } catch { /* no events.csv */ }

  // what the app logged about the ECG sensor: missing from the sensor list, or registerListener() == false
  const ecgReg = rep.registration.find((l) => / com\.google\.sensor\.ecg \|/.test(l));
  const refused = ecgReg?.includes("registered=false") ?? false;
  const missing = rep.registration.some((l) => /raw_missing com\.google\.sensor\.ecg$/.test(l));
  const ecg = loadRaw(join(session, "raw_ecg.csv"));
  const lead = loadRaw(join(session, "raw_ecg_lead.csv"));

  // lead detector
  if (lead && lead.t.length) {
    rep.lead = fileStats(lead);
    let prev = "";
    lead.t.forEach((t, i) => {
      const s = lead.vals[i].join(" ");
      rep.leadSeries.t.push(t); rep.leadSeries.v.push(lead.vals[i][0]);
      if (s !== prev) { rep.leadChanges.push({ t, value: s }); prev = s; }
    });
  }

  if (refused || missing) {
    rep.verdict = "blocked";
    rep.verdictText = missing
      ? "ECG blocked: the ECG sensor is not visible to this app (raw_missing in events.csv)."
      : "ECG blocked: registerListener() refused the ECG sensor (registered=false) – it probably needs a permission a third-party app cannot get.";
    if (ecg) rep.ecg = fileStats(ecg);
  } else if (!ecg) {
    rep.verdict = "no_file";
    rep.verdictText = "raw_ecg.csv missing – not an ECG-test session, or the app did not log the ECG sensor (see events.csv).";
  } else {
    const st = rep.ecg = fileStats(ecg);
    L.push(`ECG: ${st.events} events, ${f(st.durationS, 1)} s, rate ≈ ${f(st.eventRateHz, 1)} Hz, ` +
      `values/event ${JSON.stringify(st.valuesPerEvent)}, accuracy ${JSON.stringify(st.accuracy)}, duplicate timestamps ${f(st.duplicatePct)} %`);
    if (!st.events) {
      rep.verdict = "blocked";
      rep.verdictText = "ECG blocked? The sensor accepted the registration but delivered 0 events. A third-party app apparently gets no ECG data.";
    } else {
      const cols = columns(ecg);
      rep.channels = cols.map((x, c) => channelStats(`v${c}`, x));
      for (const c of rep.channels) L.push(`  ${c.name}: mean ${f(c.mean, 3)} std ${f(c.std, 3)} min ${f(c.min, 3)} max ${f(c.max, 3)} unique ${c.unique}`);
      if (rep.channels.every((c) => c.unique <= 1)) {
        rep.verdict = "constant";
        rep.verdictText = "ECG sensor delivers events, but every value is constant – no usable signal (placeholder or blocked).";
      } else {
        const cands = candidates(ecg, st).filter((c) => new Set(c.x).size > 1);
        let best: { c: Candidate; d: RDetect } | null = null;
        for (const c of cands) {
          const d = detectR(c.x, c.fs);
          L.push(`  ${c.label} @ ${f(c.fs, 1)} Hz: ${d.peaks.length} peaks, ${d.why}`);
          if (!best || d.score > best.d.score) best = { c, d };
        }
        if (best) {
          const { c, d } = best;
          rep.best = { label: c.label, fs: c.fs, beats: d.peaks.length, hr: d.hr, looksEcg: d.looksEcg, why: d.why };
          rep.verdict = d.looksEcg ? "ecg" : "not_ecg";
          rep.verdictText = d.looksEcg
            ? `${c.label} looks like an ECG: ${d.peaks.length} R peaks, heart rate ${f(d.hr ?? NaN)} bpm.`
            : `Data arrives, but no channel looks like an ECG (best: ${c.label}, ${d.why}). Finger on the crown during the whole test?`;
          const peakT = d.peaks.map(c.tOf);
          d.peaks.slice(1).forEach((p, i) => { rep.rr.t.push(peakT[i + 1]); rep.rr.rr.push(d.rr[i]); });
          if (d.looksEcg) rep.hrv = hrv(d.rr);
          // 10-s snippet: the window with the most plausible RR intervals
          const win = Math.round(10 * c.fs);
          let s0 = Math.max(0, Math.floor((c.x.length - win) / 2)), bestN = -1;
          for (let s = 0; s + win <= c.x.length; s += Math.max(1, Math.round(c.fs))) {
            const nOk = d.rr.filter((v, i) => d.peaks[i] >= s && d.peaks[i + 1] < s + win && v >= RR_MIN && v <= RR_MAX).length;
            if (nOk > bestN) { bestN = nOk; s0 = s; }
          }
          const s1 = Math.min(c.x.length, s0 + win);
          const idx = Array.from({ length: s1 - s0 }, (_, k) => s0 + k);
          rep.snippet = {
            t: idx.map(c.tOf), raw: idx.map((i) => c.x[i]), filt: idx.map((i) => d.filt[i] ?? NaN),
            peaks: d.peaks.filter((p) => p >= s0 && p < s1).map(c.tOf),
          };
        }
      }
    }
  }

  // heart-rate sensor in the same period
  const tA = rep.ecg?.firstMs ?? -Infinity, tB = rep.ecg?.lastMs ?? Infinity;
  if (existsSync(join(session, "hr.csv"))) {
    for (const line of readFileSync(join(session, "hr.csv"), "utf8").split("\n").slice(1)) {
      const [t, bpm] = line.split(",").map(Number);
      if (Number.isFinite(t) && bpm > 30 && t >= tA - 5000 && t <= tB + 5000) { rep.hrSensor.t.push(t); rep.hrSensor.bpm.push(bpm); }
    }
  }

  // PPG beats as a second reference (same rules as ppg.ts, without motion mask: the test is done sitting still)
  if (existsSync(join(session, "raw_ppg.csv"))) {
    try {
      const optical = loadPpg(session);
      if (optical.t.length) {
        const { beats } = analyseRecording(optical, new Uint8Array(optical.t.length));
        if (beats.t.length) {
          const ok = beats.t.map((_, i) => i).filter((i) => beats.clean[i]);
          const ibi = ok.map((i) => beats.ibi[i]);
          let ptt: number | null = null, matched = 0;
          const rT = rep.snippet ? rep.rr.t : [];
          if (rT.length) {
            const d = rT.map((r) => beats.t.find((b) => b > r + 50 && b <= r + 600)).filter((b, i): b is number => b !== undefined && rT[i] !== undefined).length;
            const delays: number[] = [];
            for (const r of rT) { const b = beats.t.find((x) => x > r + 50 && x <= r + 600); if (b !== undefined) delays.push(b - r); }
            matched = d; ptt = delays.length >= 5 ? median(delays) : null;
          }
          rep.ppg = { t: ok.map((i) => beats.t[i]), ibi, hr: ibi.length >= 5 ? 60000 / median(ibi) : null, ptt, matched };
        }
      }
    } catch (e) { L.push(`PPG reference failed: ${(e as Error).message}`); }
  }

  // summary lines
  const head = [`ECG test ${rep.session}: ${rep.verdictText}`];
  if (rep.lead) {
    head.push(`Lead detector: ${rep.lead.events} events, ${rep.leadChanges.length} distinct states: ` +
      rep.leadChanges.slice(0, 12).map((c) => `${hms(c.t, rep.timeZone)}=${c.value}`).join(", ") + (rep.leadChanges.length > 12 ? " …" : ""));
  } else head.push("Lead detector: no data");
  if (rep.best?.hr != null) {
    const rr = rep.rr.rr.filter((v) => v >= RR_MIN && v <= RR_MAX);
    head.push(`ECG heart rate ${f(rep.best.hr, 1)} bpm from ${rr.length} RR intervals (${f(Math.min(...rr))}–${f(Math.max(...rr))} ms)`);
  }
  if (rep.hrv) {
    const h = rep.hrv;
    head.push(`HRV (ECG, ${f(h.durationS)} s, ${h.nn} normal intervals): RMSSD ${f(h.rmssd ?? NaN, 1)} ms, SDNN ${f(h.sdnn ?? NaN, 1)} ms, ` +
      `pNN50 ${f(h.pnn50 ?? NaN, 1)} %, extrasystoles ${h.ectopic}, artefacts ${h.artefacts} – ${h.note}`);
  }
  if (rep.hrSensor.bpm.length) head.push(`Watch heart-rate sensor in the same period: ${f(mean(rep.hrSensor.bpm), 1)} bpm`);
  if (rep.ppg) {
    head.push(`PPG: ${rep.ppg.t.length} clean beats` + (rep.ppg.hr != null ? `, ${f(rep.ppg.hr, 1)} bpm` : "") +
      (rep.ppg.ptt != null ? `, R peak → pulse wave ${f(rep.ppg.ptt)} ms (median, ${rep.ppg.matched} pairs)` : ""));
  }
  rep.lines = [...head, ...L, "Note: experimental, not a medical device, no diagnosis."];
  return rep;
}

// ---------- SVG plot ----------

function panel(y0: number, h: number, w: number, title: string, series: { t: number[]; v: number[]; color: string; dots?: boolean; step?: boolean }[], tA: number, tB: number): string {
  const all = series.flatMap((s) => s.v.filter(Number.isFinite));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (!all.length) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const X = (t: number) => 60 + ((t - tA) / Math.max(1, tB - tA)) * (w - 80);
  const Y = (v: number) => y0 + 22 + (1 - (v - lo) / (hi - lo)) * (h - 34);
  let s = `<text x="60" y="${y0 + 14}" font-size="12" fill="#333">${title}</text>`;
  s += `<rect x="60" y="${y0 + 22}" width="${w - 80}" height="${h - 34}" fill="none" stroke="#ddd"/>`;
  s += `<text x="55" y="${y0 + 30}" font-size="9" text-anchor="end" fill="#777">${f(hi, 1)}</text><text x="55" y="${y0 + h - 12}" font-size="9" text-anchor="end" fill="#777">${f(lo, 1)}</text>`;
  for (const se of series) {
    if (se.dots) s += se.t.map((t, i) => `<circle cx="${X(t).toFixed(1)}" cy="${Y(se.v[i]).toFixed(1)}" r="2.5" fill="${se.color}"/>`).join("");
    else {
      const pts: string[] = [];
      se.t.forEach((t, i) => {
        if (!Number.isFinite(se.v[i])) return;
        if (se.step && pts.length) pts.push(`${X(t).toFixed(1)},${Y(se.v[i - 1] ?? se.v[i]).toFixed(1)}`);
        pts.push(`${X(t).toFixed(1)},${Y(se.v[i]).toFixed(1)}`);
      });
      s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${se.color}" stroke-width="1"/>`;
    }
  }
  return s;
}

export function reportSvg(r: EcgReport): string {
  const w = 1000, h = 150, parts: string[] = [];
  let y = 0;
  if (r.snippet) {
    const a = r.snippet.t[0], b = r.snippet.t[r.snippet.t.length - 1];
    parts.push(panel(y, h, w, `ECG raw (${r.best?.label}), 10 s from ${hms(a, r.timeZone)}`, [{ t: r.snippet.t, v: r.snippet.raw, color: "#555" }], a, b)); y += h;
    const pk = r.snippet.peaks.map((p) => r.snippet!.filt[r.snippet!.t.findIndex((t) => t >= p)]);
    parts.push(panel(y, h, w, "filtered 0.5–40 Hz, dots = R peaks", [
      { t: r.snippet.t, v: r.snippet.filt, color: "#1f6feb" }, { t: r.snippet.peaks, v: pk, color: "#d1242f", dots: true }], a, b)); y += h;
  }
  const t0 = r.ecg?.firstMs ?? r.lead?.firstMs ?? 0, t1 = r.ecg?.lastMs ?? r.lead?.lastMs ?? 1;
  parts.push(panel(y, h, w, "RR intervals (ms): blue = ECG, orange = PPG beats, purple = heart-rate sensor", [
    { t: r.rr.t, v: r.rr.rr, color: "#1f6feb", dots: true },
    ...(r.ppg ? [{ t: r.ppg.t, v: r.ppg.ibi, color: "#d97706", dots: true }] : []),
    { t: r.hrSensor.t, v: r.hrSensor.bpm.map((b) => 60000 / b), color: "#8250df" }], t0, t1)); y += h;
  parts.push(panel(y, h * 0.7, w, "Lead detector (first value)", [{ t: r.leadSeries.t, v: r.leadSeries.v, color: "#1a7f37", step: true }], t0, t1)); y += h * 0.7;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${y + 10}" font-family="sans-serif"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>\n`;
}

// ---------- HRV history over all ECG tests ----------

export interface HrvRow {
  session: string; start: number; durationS: number; hr: number | null; rmssd: number | null; sdnn: number | null;
  pnn50: number | null; ectopic: number; nn: number; valid: boolean; note: string;
}
const histCache = new Map<string, { mtime: number; row: HrvRow | null }>();

/** One row per session with a usable ECG (cached by raw_ecg.csv mtime), oldest first. */
export function hrvHistory(sessionsDir: string): HrvRow[] {
  const rows: HrvRow[] = [];
  let names: string[] = [];
  try { names = readdirSync(sessionsDir).sort(); } catch { return rows; }
  for (const name of names) {
    const file = join(sessionsDir, name, "raw_ecg.csv");
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    const hit = histCache.get(file);
    let row: HrvRow | null;
    if (hit && hit.mtime === mtime) row = hit.row;
    else {
      row = null;
      try {
        const r = analyzeEcg(join(sessionsDir, name));
        if (r.hrv && r.rr.t.length) {
          const h = r.hrv;
          row = { session: name, start: r.rr.t[0], durationS: h.durationS, hr: h.hr, rmssd: h.rmssd, sdnn: h.sdnn, pnn50: h.pnn50, ectopic: h.ectopic, nn: h.nn, valid: h.valid, note: h.note };
        }
      } catch { /* unreadable session */ }
      histCache.set(file, { mtime, row });
    }
    if (row) rows.push(row);
  }
  return rows;
}

export function writeHrvHistory(sessionsDir: string): string {
  const rows = hrvHistory(sessionsDir);
  const out = join(sessionsDir, "hrv_ecg.csv");
  writeCsv(out, ["session", "start", "duration_s", "hr", "rmssd_ms", "sdnn_ms", "pnn50", "extrasystoles", "nn", "valid", "note"],
    rows.map((r) => [r.session, new Date(r.start).toISOString(), r.durationS, r.hr ?? "", r.rmssd ?? "", r.sdnn ?? "", r.pnn50 ?? "", r.ectopic, r.nn, r.valid ? "yes" : "no", r.note]));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const hi = args.indexOf("--history");
  if (hi >= 0) {
    const dir = args[hi + 1] ?? join("..", "sessions");
    const out = writeHrvHistory(dir);
    for (const r of hrvHistory(dir)) {
      console.log(`${r.session}  ${hms(r.start, sessionTimeZone(join(dir, r.session)))}  ${String(Math.round(r.durationS)).padStart(4)} s  HR ${f(r.hr ?? NaN, 1)}  RMSSD ${f(r.rmssd ?? NaN, 1)}  SDNN ${f(r.sdnn ?? NaN, 1)}  ES ${r.ectopic}  ${r.valid ? "" : "(" + r.note + ")"}`);
    }
    console.log(`Table: ${out}`);
    return;
  }
  const session = args.find((a) => !a.startsWith("--"));
  if (!session) { console.error("Usage: tsx src/ecg_probe.ts <session>   |   --history [sessions dir]"); process.exit(2); }
  const r = analyzeEcg(session);
  const text = r.lines.join("\n");
  console.log(text);
  if (r.registration.length) console.log("\nevents.csv:\n  " + r.registration.join("\n  "));
  writeFileSync(join(session, "ecg_summary.txt"), text + "\n", "utf8");
  writeCsv(join(session, "ecg_beats.csv"), ["epoch_ms", "rr_ms"], r.rr.t.map((t, i) => [t, r.rr.rr[i]]));
  writeFileSync(join(session, "ecg_probe.svg"), reportSvg(r), "utf8");
  console.log(`\nPlot: ${join(session, "ecg_probe.svg")}`);
}

if (process.argv[1]?.endsWith("ecg_probe.ts")) main();
