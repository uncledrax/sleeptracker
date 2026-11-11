/** Reading/writing files, time zones, number formatting like Python. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Sessions written before timeZone metadata used Berlin local time.
const LEGACY_ZONE = "Europe/Berlin";

export function sessionTimeZone(session: string, override?: string): string {
  const path = join(session, "session.json");
  const zone = override ?? (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).timeZone : undefined) ?? LEGACY_ZONE;
  if (typeof zone !== "string" || !zone) throw new Error("Invalid session time zone");
  formatter(zone);  // validates the IANA ID, including explicit CLI overrides
  return zone;
}

/** Numeric CSV columns (header row, comma-separated) as Float64Arrays. Non-numbers become NaN. */
export function readNumericCsv(path: string, cols?: string[]): Record<string, Float64Array> {
  const buf = readFileSync(path);
  let nl = buf.indexOf(10);
  const header = buf.toString("latin1", 0, nl).replace(/\r$/, "").split(",");
  const want = (cols ?? header).map((c) => {
    const i = header.indexOf(c);
    if (i < 0) throw new Error(`${path}: Spalte ${c} fehlt`);
    return i;
  });
  let lines = 0;
  for (let i = nl + 1; i < buf.length; i++) if (buf[i] === 10) lines++;
  if (buf[buf.length - 1] !== 10) lines++;
  const out = want.map(() => new Float64Array(lines));
  let row = 0, pos = nl + 1;
  while (pos < buf.length) {
    let end = buf.indexOf(10, pos);
    if (end < 0) end = buf.length;
    if (end > pos) {
      const parts = buf.toString("latin1", pos, end).split(",");
      for (let k = 0; k < want.length; k++) {
        const v = parts[want[k]];
        out[k][row] = v === undefined || v === "" ? NaN : Number(v);
      }
      row++;
    }
    pos = end + 1;
  }
  const res: Record<string, Float64Array> = {};
  (cols ?? header).forEach((c, k) => (res[c] = out[k].subarray(0, row)));
  return res;
}

/** events.csv: epoch_ms,"text" */
export function readEvents(session: string): { t: number; event: string }[] {
  const p = join(session, "events.csv");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const i = l.indexOf(",");
    let e = l.slice(i + 1);
    if (e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1).replace(/""/g, '"');
    return { t: Number(l.slice(0, i)), event: e };
  });
}

/** Sort records by a time field (stable), carrying all columns along. */
export function sortBy(cols: Record<string, Float64Array>, key: string): Record<string, Float64Array> {
  const t = cols[key];
  let sorted = true;
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) { sorted = false; break; }
  if (sorted) return cols;
  const idx = Array.from(t, (_, i) => i).sort((a, b) => t[a] - t[b] || a - b);
  const out: Record<string, Float64Array> = {};
  for (const [k, v] of Object.entries(cols)) out[k] = Float64Array.from(idx, (i) => v[i]);
  return out;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    fmtCache.set(zone, fmt);
  }
  return fmt;
}

function parts(ms: number, zone: string) {
  const out: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(ms)) out[p.type] = p.value;
  return out;
}

function tzOffsetMin(ms: number, zone: string): number {
  const o = parts(ms, zone);
  const asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  return (asUtc - Math.floor(ms / 1000) * 1000) / 60000;
}

export function hms(ms: number, zone = LEGACY_ZONE): string {
  const o = parts(ms, zone);
  return `${o.hour}:${o.minute}:${o.second}`;
}

export function hm(ms: number, zone = LEGACY_ZONE): string {
  return hms(ms, zone).slice(0, 5);
}

export function isoLocal(ms: number, zone = LEGACY_ZONE): string {
  const o = parts(ms, zone);
  const off = tzOffsetMin(ms, zone);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}:${o.second}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Explicit ISO offsets are authoritative. Skip nonexistent or ambiguous offset-free local times. */
export function timestampToEpoch(value: string, zone = LEGACY_ZONE): number {
  if (typeof value !== "string") return NaN;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
  if (!m) return NaN;
  const wall = `${m[1]}T${m[2]}:${m[3] ?? "00"}.${(m[4] ?? "").padEnd(3, "0").slice(0, 3)}`;
  const naive = Date.parse(wall + "Z");
  if (!Number.isFinite(naive) || new Date(naive).toISOString() !== wall + "Z") return NaN;
  if (m[5]) return Date.parse(wall + m[5]);
  const day = 86400000;
  const offsets = new Set([tzOffsetMin(naive - day, zone), tzOffsetMin(naive + day, zone)]);
  const matches = Array.from(offsets, (offset) => naive - offset * 60000)
    .filter((instant) => instant + tzOffsetMin(instant, zone) * 60000 === naive);
  return matches.length === 1 ? matches[0] : NaN;
}

/** Number like Python repr (shortest representation, NaN empty like pandas). */
export function num(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toFixed(1).replace(/\.0$/, ".0");
  return String(v);
}

/**
 * Python-style f"{v:.{d}f}" (NaN -> "nan"): rounds the exact binary value, exact .5 to the even
 * digit (2.25 -> "2.2", 0.5 -> "0"). JS toFixed would round up here.
 */
export function f(v: number, d = 0): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v) || Math.abs(v) >= 1e21) return String(v);
  const exact = Math.abs(v).toFixed(Math.min(100, d + 60));   // exact decimal representation of the double
  const [ip, fp] = exact.split(".");
  const keep = fp.slice(0, d), rest = fp.slice(d);
  let digits = ip + keep;
  const up = rest[0] > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || Number(digits[digits.length - 1]) % 2 === 1));
  if (up) {
    const arr = digits.split("").map(Number);
    let i = arr.length - 1;
    while (i >= 0) { if (arr[i] === 9) { arr[i] = 0; i--; } else { arr[i]++; break; } }
    if (i < 0) arr.unshift(1);
    digits = arr.join("");
  }
  const intPart = digits.slice(0, digits.length - d) || "0";
  const out = d ? `${intPart}.${digits.slice(digits.length - d)}` : intPart;
  return v < 0 || Object.is(v, -0) ? "-" + out : out;   // Python also writes "-0"
}

export function writeCsv(path: string, header: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const cell = (v: string | number | boolean | null | undefined) =>
    typeof v === "number" ? num(v) : typeof v === "boolean" ? (v ? "True" : "False") : v == null ? "" :
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  writeFileSync(path, [header.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n");
}

export function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
