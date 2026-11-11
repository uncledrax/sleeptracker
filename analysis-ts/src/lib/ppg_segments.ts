import { median } from "./stats.ts";

export interface OpticalSegment {
  from: number;
  end: number; // exclusive
  width: number;
  fs: number;
  reason: "start" | "layout change" | "sample-rate change" | "timestamp gap" | "invalid input" | "raw event width or timing availability change";
}

function periodAt(t: ArrayLike<number>, i: number, end: number): number {
  const dt: number[] = [];
  for (let k = i + 1; k < Math.min(i + 10, end); k++) dt.push(t[k] - t[k - 1]);
  return median(dt);
}

/** Raw array lengths in older CSVs exclude trailing zeros. Require five matching frames to infer a layout change. */
export function opticalSegments(t: ArrayLike<number>, widths: ArrayLike<number>, breaks?: Uint8Array): OpticalSegment[] {
  if (!t.length) return [];
  const result: OpticalSegment[] = [];
  let from = 0, width = widths[0], period = periodAt(t, 0, t.length);
  let reason: OpticalSegment["reason"] = "start";
  function finish(end: number) {
    const duration = t[end - 1] - t[from];
    const fs = duration > 0 ? 1000 * (end - from - 1) / duration : NaN;
    result.push({ from, end, width, fs, reason });
  }
  for (let i = 1; i < t.length; i++) {
    const dt = t[i] - t[i - 1];
    let change: OpticalSegment["reason"] | undefined;
    if (breaks?.[i]) change = breaks[i] === 2 ? "raw event width or timing availability change" : "invalid input";
    else if (widths[i] !== width && i + 4 < t.length &&
      widths[i + 1] === widths[i] && widths[i + 2] === widths[i] &&
      widths[i + 3] === widths[i] && widths[i + 4] === widths[i]) change = "layout change";
    else if (dt > 1.25 * period || dt < 0.75 * period) {
      // Differentiate sustained, regularly spaced events at a new rate from one missing burst.
      const end = Math.min(i + 6, t.length);
      let regular = end === i + 6;
      for (let k = i + 1; k < end && regular; k++) regular = Math.abs((t[k] - t[k - 1]) / dt - 1) < 0.2;
      if (regular) change = "sample-rate change";
      else if (dt > 2.5 * period) change = "timestamp gap";
    }
    if (change) {
      finish(i);
      from = i; width = widths[i]; period = periodAt(t, i, t.length); reason = change;
    }
  }
  finish(t.length);
  return result;
}

/** Intervals retain their original positions: an excluded interval breaks the successive-difference chain. */
export function successiveDifferences(n: number, interval: (i: number) => number, eligible: (i: number) => boolean,
  adjacent: (i: number) => boolean): number[] {
  const differences: number[] = [];
  let previous = false;
  for (let i = 0; i < n; i++) {
    const ok = eligible(i);
    if (previous && ok && adjacent(i)) differences.push(interval(i) - interval(i - 1));
    previous = ok;
  }
  return differences;
}
