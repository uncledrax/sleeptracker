import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hrv, loadPpg, padMotion, type Beats } from "../src/ppg.ts";
import { State } from "../src/live_core.ts";
import { opticalSegments } from "../src/lib/ppg_segments.ts";

test("raw reader drops out-of-order samples relative to the last accepted event", () => {
  const dir = mkdtempSync(join(tmpdir(), "optical-order-"));
  try {
    writeFileSync(join(dir, "raw_ppg.csv"), "epoch_ms,accuracy,n,values\n100,3,1,99\n80,3,1,22\n90,3,1,33\n110,3,1,44");
    const p = loadPpg(dir);
    assert.deepEqual([...p.t], [100, 110]);
    assert.equal(p.discarded, 2);
    assert.equal(p.breaks[1], 1);
    writeFileSync(join(dir, "session.json"), JSON.stringify({epochOffsetNs: "0"}));
    writeFileSync(join(dir, "raw_ppg_timing.csv"), "sensor_timestamp_ns,event_width\n100500000,16\n80000000,16\n90000000,16\n110250000,16\n");
    const exact = loadPpg(dir);
    assert.deepEqual([...exact.t], [100.5, 110.25]);
    assert.deepEqual([...exact.eventWidths], [16, 16]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("PPG RMSSD only uses adjacent accepted intervals in one optical segment", () => {
  const ibi = [900, 900, 1000, 1100, 1100, 1000, 1000];
  const b: Beats = {
    ibi, ibiMed: ibi, t: [900, 1800, 2800, 3900, 5000, 6000, 7000],
    clean: [true, true, false, true, true, true, true], flag: ibi.map(() => ""), segment: [1,1,1,1,1,2,2],
    amp: [], corr: [], moving: []
  };
  const result = hrv(b);
  assert.equal(result.rmssd, 0);
  assert.equal(result.pairs, 3);
});

test("at 25 Hz, PPG motion rejection extends three real seconds on each side", () => {
  const t = Float64Array.from({length: 201}, (_, i) => i * 40);
  const moving = new Uint8Array(t.length); moving[100] = 1;
  const mask = padMotion(t, moving);
  assert.equal(mask[24], 0); assert.equal(mask[25], 1);
  assert.equal(mask[175], 1); assert.equal(mask[176], 0);
});

test("one trimmed zero does not create a new acquisition layout", () => {
  const t = Float64Array.from({length: 100}, (_, i) => i * 10);
  const width = new Uint16Array(t.length).fill(7);
  width[15] = 6;
  assert.equal(opticalSegments(t, width).length, 1);
});

test("CLI selects separate channels and reports coverage after layout, rate and time changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "optical-segments-"));
  try {
    const ppg = ["epoch_ms,accuracy,n,values"], acc = ["epoch_ms,x,y,z"];
    let t = 100000;
    const segment = (width: number, dt: number) => {
      for (let i = 0; i < 24000 / dt; i++) {
        const values = Array(width).fill(1000);
        values[width - 1] = 120000 + Math.round(1000 * Math.cos(2 * Math.PI * t / 900));
        ppg.push([t, 3, width, values.join(" ")].join(","));
        t += dt;
      }
    };
    segment(6, 10); segment(7, 10); segment(7, 40); t += 2000; segment(7, 40);
    for (let a = 100000; a < t; a += 40) acc.push(`${a},0,0,9.81`);
    writeFileSync(join(dir, "raw_ppg.csv"), ppg.join("\n"));
    writeFileSync(join(dir, "accel.csv"), acc.join("\n"));
    const cli = fileURLToPath(new URL("../src/ppg.ts", import.meta.url));
    execFileSync(process.execPath, [...process.execArgv.filter(a => !a.startsWith("--test")), cli, dir]);
    const lines = readFileSync(join(dir, "ppg_segments.csv"), "utf8").trim().split("\n");
    const cols = lines.shift()!.split(",");
    const rows = lines.map(l => Object.fromEntries(l.split(",").map((v,i) => [cols[i],v])));
    assert.deepEqual(rows.map(r => r.boundary), ["start", "layout change", "sample-rate change", "timestamp gap"]);
    assert.deepEqual(rows.map(r => Number(r.channel)), [5,6,6,6]);
    assert.deepEqual(rows.map(r => Math.round(Number(r.sample_hz))), [100,100,25,25]);
    assert.ok(rows.every(r => Number(r.clean_minutes) > 0.2));
    const beats = readFileSync(join(dir, "ppg_beats.csv"), "utf8").trim().split("\n").slice(1).map(r => r.split(","));
    for (let i = 1; i < beats.length; i++) if (beats[i].at(-1) !== beats[i-1].at(-1)) {
      assert.equal(beats[i][4], ""); assert.equal(beats[i][5], "False");
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("live processing retains an eighth optical channel and clears pulse history at a gap", () => {
  const state = new State(7, null);
  let t = 100000;
  for (let i = 0; i < 280; i++, t += 40) {
    const y = 120000 + 4000 * Math.sin(2 * Math.PI * t / 850);
    state.feed(`p,${t},1 2 3 4 5 6 7 ${y}`);
  }
  state.process();
  const s = state.snapshot();
  assert.equal(s.diag.ppg_hz, 25);
  assert.equal(s.channels?.width, 8);
  assert.equal(s.channels?.history.at(-1)?.dc.length, 8);
  assert.ok(s.ibis.length >= 5);
  state.feed(`p,${t+2000},1 2 3 4 5 6 7 120000`); state.process();
  assert.deepEqual(state.snapshot().ibis, []);
});

test("live RMSSD does not bridge movement flags or absent IBIs", () => {
  const state = new State(0, null);
  let t = 100000;
  for (const [ibi, flag] of [[900,""],[900,""],[900,""],[900,""],[900,""],[1000,"moving"],
    [1000,""],[1000,""],[1000,""],[1000,""],[1000,""]] as const) {
    t += ibi;
    state.ibis.push([t, ibi, flag]);
  }
  state.feed(`p,${t},10000`);
  assert.equal(state.snapshot().numbers.rmssd, 0);
});

test("live pulse recovers from a 20 s acquisition gap without replaying old beats or rate", (ctx) => {
  const wall = 2_000_000;
  const clock = ctx.mock.method(Date, "now", () => wall);
  const state = new State(5, null);
  const feed = (t: number) => state.feed(`p,${t},1 2 3 4 5 ${85000 + 3500 * Math.sin(t / 900 * 2 * Math.PI)}`);
  let t = 100_000;
  for (let i = 0; i < 1400; i++, t += 10) {
    feed(t);
    if (i % 25 === 0) state.process();
  }
  state.process();
  assert.ok(state.snapshot().ibis.length > 5);
  assert.ok(state.snapshot().ppg.t.length > 0);
  clock.mock.mockImplementation(() => wall + 4000);
  state.feed(`h,${t},63`); // other data can still be live while optical samples have stopped
  assert.equal(state.snapshot().connected, true);
  assert.equal(state.snapshot().diag.ppg_fresh, false);
  assert.equal(state.snapshot().numbers.hr_ppg, null);
  assert.equal(state.snapshot().numbers.rmssd, null);
  assert.equal(state.snapshot().ppg.t.length, 0);
  t += 20_000;
  for (let i = 0; i < 10; i++, t += 10) feed(t);
  state.process();
  const first = state.snapshot();
  assert.equal(first.diag.ppg_fresh, true);
  assert.equal(first.numbers.hr_ppg, null);
  assert.deepEqual(first.ibis, []);
  assert.deepEqual(first.ppg.t, []);
  for (let i = 0; i < 1200; i++, t += 10) feed(t);
  state.process();
  assert.ok(state.snapshot().ibis.length > 5);
});
