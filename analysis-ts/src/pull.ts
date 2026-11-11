/**
 * Fetch recordings from the watch over Wi-Fi debugging in one command:
 *   npm run pull                 # new and changed sessions → ../sessions
 *   npm run pull -- --list       # only show what is on the watch
 *   npm run pull -- --delete     # afterwards delete on the watch what is complete and identical locally
 *   npm run pull -- --serial 192.168.1.50:44691 --out D:\sessions
 * The watch is found automatically (see lib/adb.ts). A session that is still recording is fetched as it is now
 * and fetched again next time; it is never deleted.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestDifferences, FILE_NAME, MANIFEST, parseManifest, SESSION_NAME, type Digests } from "./lib/manifest.ts";
import { adb, findWatch, PKG } from "./lib/adb.ts";

export interface RemoteSession { name: string; files: Record<string, number>; bytes: number; lastWrite: number; recording: boolean }

/** Parses `date +%s` followed by `stat -c '%s %Y %n'` lines (paths relative to files/sessions). */
export function parseListing(text: string): RemoteSession[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const now = Number(lines.shift());
  const by = new Map<string, RemoteSession>();
  for (const l of lines) {
    const m = l.match(/^(\d+) (\d+) ([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, size, mtime, name, file] = m;
    if (!SESSION_NAME.test(name) || !FILE_NAME.test(file) || file.endsWith(".part")) continue;
    const s = by.get(name) ?? { name, files: {}, bytes: 0, lastWrite: 0, recording: false };
    s.files[file] = Number(size); s.bytes += Number(size); s.lastWrite = Math.max(s.lastWrite, Number(mtime));
    by.set(name, s);
  }
  // A recent write is a display hint for unsealed sessions. It never authorizes deletion.
  for (const s of by.values()) s.recording = !(MANIFEST in s.files) && Number.isFinite(now) && now - s.lastWrite < 120;
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function localFiles(dir: string): Record<string, number> {
  if (!existsSync(dir)) return {};
  const out: Record<string, number> = {};
  for (const f of readdirSync(dir)) { const st = statSync(join(dir, f)); if (st.isFile()) out[f] = st.size; }
  return out;
}

/** Files of the watch session that are missing locally or have a different size (extra local files like summary.txt are fine). */
export function differences(remote: RemoteSession, local: Record<string, number>): string[] {
  return Object.keys(remote.files).filter((f) => local[f] !== remote.files[f]);
}

/** Stage complete archive entries on the destination filesystem. Publishing happens after EOF,
 * successful adb exit, and the caller's integrity checks. Existing analysis outputs are preserved. */
export class TarExtract {
  private buf: Buffer = Buffer.alloc(0);
  private fd: number | null = null;
  private left = 0;
  private pad = 0;
  private longName: string | null = null;
  private longBuf: Buffer[] | null = null;
  private eof = false;
  private readonly staging: string;
  files: string[] = [];
  constructor(private root: string, private onFile?: (name: string, size: number) => void) {
    mkdirSync(root, { recursive: true });
    this.staging = mkdtempSync(join(root, ".pull-"));
  }
  write(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.left > 0) {
        if (!this.buf.length) return;
        const n = Math.min(this.left, this.buf.length), part = this.buf.subarray(0, n);
        if (this.longBuf) this.longBuf.push(Buffer.from(part));
        else if (this.fd !== null) {
          let off = 0;
          while (off < n) off += writeSync(this.fd, part, off, n - off);
        }
        this.buf = this.buf.subarray(n); this.left -= n;
        if (this.left === 0) this.finishEntry();
        continue;
      }
      if (this.pad > 0) {
        const n = Math.min(this.pad, this.buf.length);
        this.buf = this.buf.subarray(n); this.pad -= n;
        if (this.pad > 0) return;
        continue;
      }
      if (this.buf.length < 512) return;
      const h = this.buf.subarray(0, 512);
      this.buf = this.buf.subarray(512);
      if (h.every((b) => b === 0)) { this.eof = true; continue; }
      if (this.eof) throw new Error("Unexpected data following tar terminator");
      const str = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(str(124, 136).trim() || "0", 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid tar length");
      const type = String.fromCharCode(h[156] || 48);
      const prefix = h.subarray(257, 263).toString("latin1").startsWith("ustar") ? str(345, 500) : "";
      let name = this.longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
      this.longName = null;
      name = name.replace(/^\.\//, "");
      this.left = size; this.pad = (512 - (size % 512)) % 512;
      if (type === "L") { this.longBuf = []; if (size === 0) this.finishEntry(); continue; }
      if (type === "0" || type === "\0" || type === "7") {
        const path = name.split("/");
        if (path.length !== 2 || !SESSION_NAME.test(path[0]) || !FILE_NAME.test(path[1])) {
          throw new Error(`Unexpected recording entry: ${name}`);
        }
        const target = join(this.staging, name);
        mkdirSync(dirname(target), { recursive: true });
        this.fd = openSync(target, "wx");
        this.files.push(name);
        this.onFile?.(name, size);
        if (size === 0) this.finishEntry();
      }
    }
  }
  private finishEntry() {
    if (this.longBuf) { this.longName = Buffer.concat(this.longBuf).toString("utf8").replace(/\0.*$/s, ""); this.longBuf = null; }
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
  }
  abort() {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    rmSync(this.staging, { recursive: true, force: true });
  }
  async end(validate?: (stage: string) => Promise<void>) {
    try {
      if (!this.eof || this.left || this.pad || this.fd !== null || this.longName || this.buf.length) {
        throw new Error("Incomplete ADB archive; prior local files retained");
      }
      await validate?.(this.staging);
      // Install completion markers last. The entire transfer has already been validated.
      for (const name of this.files.slice().sort((a, b) => Number(a.endsWith("/" + MANIFEST)) - Number(b.endsWith("/" + MANIFEST)))) {
        const target = join(this.root, name);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(this.staging, name), target);
      }
    } finally { this.abort(); }
  }
}

function listRemote(serial: string): RemoteSession[] {
  const r = adb(["-s", serial, "shell", `run-as ${PKG} sh -c 'date +%s; cd files/sessions 2>/dev/null && stat -c "%s %Y %n" */* 2>/dev/null'`], 30000);
  if (!r.ok && !r.out.trim()) throw new Error(`could not read the sessions on the watch: ${r.err.trim()}`);
  return parseListing(r.out);
}

function fetch(serial: string, names: string[], outDir: string, validate: (stage: string) => Promise<void>): Promise<string[]> {
  return new Promise((res, rej) => {
    const p = spawn("adb", ["-s", serial, "exec-out", `run-as ${PKG} tar c -C files/sessions ${names.join(" ")}`]);
    let got = 0, lastLog = 0;
    const t0 = Date.now();
    const x = new TarExtract(outDir, (name) => process.stdout.write(`\n  ${name} `));
    let failed: Error | null = null;
    p.stdout.on("data", (c: Buffer) => {
      if (failed) return;
      try { x.write(c); } catch (e) { failed = e as Error; p.kill(); return; }
      got += c.length;
      if (Date.now() - lastLog > 1000) { lastLog = Date.now(); process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB, ${(got / 1e6 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s   `); }
    });
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    p.on("error", e => { x.abort(); rej(e); });
    p.on("close", async (code) => {
      process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      if (failed || code !== 0) {
        x.abort();
        return rej(failed ?? new Error(`adb exec-out ended with ${code}: ${err.trim()}`));
      }
      try { await x.end(validate); } catch (e) { return rej(e); }
      res(x.files);
    });
  });
}

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

async function main() {
  const args = process.argv.slice(2);
  const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(val("--out") ?? join(here, "..", "..", "sessions"));
  const serial = findWatch(val("--serial"));
  console.log(`Watch: ${serial}   local folder: ${outDir}`);
  const remote = listRemote(serial);
  if (!remote.length) { console.log("No sessions on the watch."); return; }

  for (const s of remote) {
    const dir = join(outDir, s.name);
    const finalized = MANIFEST in s.files;
    console.log(`  ${s.name}  ${mb(s.bytes).padStart(9)}  ${finalized ? "sealed" : s.recording ? "recently active, copy only" : "unsealed, copy only"}`);
    if (args.includes("--list")) continue;
    let expected: Digests | null = null;
    if (finalized) {
      const manifest = adb(["-s", serial, "exec-out", `run-as ${PKG} cat files/sessions/${s.name}/${MANIFEST}`]);
      if (!manifest.ok) throw new Error(`Cannot read manifest for ${s.name}`);
      expected = parseManifest(manifest.out, s.name);
      if (Object.keys(s.files).length !== Object.keys(expected).length ||
          Object.entries(expected).some(([f, d]) => s.files[f] !== d.bytes)) {
        throw new Error(`${s.name}: watch listing differs from its manifest; originals retained`);
      }
    }
    const diff = expected ? await digestDifferences(dir, expected) : differences(s, localFiles(dir));
    if (diff.length) {
      // A closed session is fetched in full on repair, then verified before any existing files are replaced.
      const files = Object.keys(s.files);
      await fetch(serial, files.map(f => `${s.name}/${f}`), outDir, async stage => {
        const incoming = join(stage, s.name);
        if (expected) {
          const bad = await digestDifferences(incoming, expected);
          if (bad.length || JSON.parse(readFileSync(join(incoming, "session.json"), "utf8")).state !== "complete") {
            throw new Error(`${s.name}: staged files failed verification (${bad.join(", ")}); originals retained`);
          }
        } else {
          const sizes = localFiles(incoming), previous = localFiles(dir);
          if (files.some(f => !(f in sizes) || sizes[f] < s.files[f] || sizes[f] < (previous[f] ?? 0))) {
            throw new Error(`${s.name}: incomplete recording snapshot; existing copies retained`);
          }
        }
      });
      console.log(`  copied ${dir}`);
    }
    if (args.includes("--delete") && expected) {
      if (JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).state !== "complete" ||
          (await digestDifferences(dir, expected)).length) throw new Error(`${s.name}: verification failed, retained`);
      // Re-read every watch digest immediately before cleanup. Only immutable, sealed sessions reach here.
      const hashes = adb(["-s", serial, "exec-out", `run-as ${PKG} sh -c 'cd files/sessions/${s.name} && sha256sum *'`], 600000);
      const actual = new Map(hashes.out.trim().split(/\r?\n/).map(line => {
        const m = line.match(/^([a-f0-9]{64})\s+([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/);
        return [m?.[2] ?? "", m?.[1] ?? ""] as const;
      }));
      if (!hashes.ok || actual.size !== Object.keys(expected).length || Object.entries(expected).some(([f, d]) => actual.get(f) !== d.sha256)) {
        throw new Error(`${s.name}: watch no longer matches the verified archive; retained`);
      }
      const r = adb(["-s", serial, "shell", `run-as ${PKG} rm -r files/sessions/${s.name}`]);
      if (!r.ok) throw new Error(`Watch cleanup failed: ${r.err.trim()}`);
      console.log(`  verified and removed from the watch: ${s.name}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
}
