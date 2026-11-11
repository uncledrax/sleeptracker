import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, lowSpo2Episodes, stageAt, type Minute } from "../src/fitbit.ts";
import { isoLocal, sessionTimeZone, timestampToEpoch } from "../src/lib/io.ts";

test("Fitbit aligns Sydney stages and minute streams with UTC watch samples", () => {
  const start = Date.parse("2026-11-11T12:00:00Z");
  const data = load({ fitbit: {
    sleep: { timeline: [{ start: "2026-11-11T23:00:00+11:00", minutes: 15, level: "light" }] },
    spo2PerMinute: [{ time: "2026-11-11T23:00:00", value: 97 }, {time: "2026-11-11T23:01:00", value: null}],
    heartRatePerMinute: [{ time: "2026-11-11T12:00:00Z", bpm: 64 }],
  }}, "Australia/Sydney");
  assert.equal(stageAt(data.stages, start), "light");
  assert.equal(data.spo2.get(start), 97);
  assert.equal(data.spo2.size, 1);
  assert.equal(data.hr.get(start), 64);
  assert.equal(isoLocal(start, "Australia/Sydney"), "2026-11-11 23:00:00+11:00");
});

test("offset-free timestamps resolve uniquely in the recorded time zone", () => {
  const zone = "Australia/Sydney";
  assert.equal(timestampToEpoch("2026-07-11T23:00:00", zone), Date.parse("2026-07-11T13:00:00Z"));
  assert.ok(Number.isNaN(timestampToEpoch("2026-10-04T02:30:00", zone))); // spring gap
  assert.ok(Number.isNaN(timestampToEpoch("2026-04-05T02:30:00", zone))); // fall fold
  assert.equal(timestampToEpoch("2026-04-05T02:30:00+10:00", zone), Date.parse("2026-04-04T16:30:00Z"));
  assert.ok(Number.isNaN(timestampToEpoch("2026-02-31T01:00:00Z", zone)));
});

test("session metadata sets the zone and an override also supports older recordings", () => {
  const dir = mkdtempSync(join(tmpdir(), "sleep-time-"));
  try {
    assert.equal(sessionTimeZone(dir), "Europe/Berlin");
    writeFileSync(join(dir, "session.json"), JSON.stringify({ timeZone: "Australia/Sydney" }));
    assert.equal(sessionTimeZone(dir), "Australia/Sydney");
    assert.equal(sessionTimeZone(dir, "UTC"), "UTC");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isolated low SpO2 minutes and missing heart rate remain distinguishable", () => {
  const rows: Minute[] = Array.from({ length: 13 }, (_, i) => ({
    minute: i * 60000, spo2: i % 3 === 0 ? 89 : 98, hr_mean: NaN, hr_max: NaN,
    hr_min: NaN, activity_mean: 0, movement_events: 0, breaths_per_min: NaN,
    cvhr_episode: false, pose_change_deg: 0,
  }));
  const [cluster] = lowSpo2Episodes(rows, [12 * 60000]);
  assert.equal(cluster.pattern, "intermittent");
  assert.equal(cluster.minutes, 5);
  assert.equal(cluster.longest_run_minutes, 1);
  assert.equal(cluster.verdict, "insufficient HR data");
  const run = rows.slice(0, 5).map((r) => ({ ...r, spo2: 89, hr_mean: 65, hr_max: 66 }));
  const [sustained] = lowSpo2Episodes(run, [4 * 60000]);
  assert.equal(sustained.pattern, "sustained");
  assert.equal(sustained.longest_run_minutes, 5);
});
