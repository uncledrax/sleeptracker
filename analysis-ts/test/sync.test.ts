import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { isPrivate, syncHandler } from "../src/lib/sync_server.ts";
import { digestDifferences, MANIFEST, parseManifest } from "../src/lib/manifest.ts";

test("isPrivate: home networks yes, public no", () => {
  for (const a of ["127.0.0.1", "::ffff:192.168.1.50", "10.1.2.3", "172.20.0.5", "169.254.1.1", "::1"]) assert.equal(isPrivate(a), true, a);
  for (const a of ["8.8.8.8", "172.32.0.1", "::ffff:93.184.216.34", undefined]) assert.equal(isPrivate(a), false, String(a));
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const session = "20261111_230000";

test("the receiver retains the previous file on a digest mismatch, and returns verified hashes after retry", async t => {
  const root = mkdtempSync(join(tmpdir(), "sync-"));
  const srv = createServer(syncHandler(root, () => {}));
  t.after(async () => {
    await new Promise<void>(resolve => srv.close(() => resolve()));
    rmSync(root, { force: true, recursive: true });
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/sessions/${session}`;
  const upload = (data: string, hash: string) => fetch(url + "/raw_ppg.csv", {
    method: "PUT", body: data, headers: { "X-Content-SHA256": hash }
  });
  assert.equal((await upload("abc", sha("abc"))).status, 200);
  assert.equal((await upload("123", sha("xyz"))).status, 400);
  assert.equal(readFileSync(join(root, session, "raw_ppg.csv"), "utf8"), "abc");
  assert.equal((await upload("xyz", sha("xyz"))).status, 200);
  const receipt = await (await fetch(url + "?hashes=1")).json();
  assert.equal(receipt.files["raw_ppg.csv"], 3);
  assert.equal(receipt.sha256["raw_ppg.csv"], sha("xyz"));
});

test("a sealed manifest detects changed content even when sizes match", async t => {
  const root = mkdtempSync(join(tmpdir(), "manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, session);
  mkdirSync(dir);
  const metadata = JSON.stringify({ state: "complete" });
  const raw = JSON.stringify({ version: 1, session, files: {
    "session.json": { bytes: Buffer.byteLength(metadata), sha256: sha(metadata) },
    "raw_ppg.csv": { bytes: 3, sha256: sha("abc") }
  } });
  const expected = parseManifest(raw, session);
  assert.throws(() => parseManifest(raw, "20261112_230000"));
  writeFileSync(join(dir, "session.json"), metadata);
  writeFileSync(join(dir, MANIFEST), raw);
  writeFileSync(join(dir, "raw_ppg.csv"), "bad");
  assert.deepEqual(await digestDifferences(dir, expected), ["raw_ppg.csv"]);
  writeFileSync(join(dir, "raw_ppg.csv"), "abc");
  assert.deepEqual(await digestDifferences(dir, expected), []);
});
