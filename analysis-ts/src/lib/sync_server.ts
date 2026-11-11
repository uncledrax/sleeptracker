/**
 * Direct Wi-Fi link to the watch (no ADB), see app/…/WifiLink.kt and SessionSync.kt.
 *  - UDP 9001: answers the watch's broadcast "SLEEPLOGGER? 1" with "SLEEPLOGGER 1 <livePort> <syncPort> <name>".
 *  - HTTP <syncPort> (default 9002): the watch uploads finished sessions.
 *      GET /sessions/<name>          -> {"files": {"accel.csv": 123, …}}   (complete files only)
 *      PUT /sessions/<name>/<file>   -> body = file content, written to <file>.part and renamed when complete
 * Only clients from private networks (home Wi-Fi) are accepted.
 */
import { createSocket } from "node:dgram";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { digestFile, SESSION_NAME, FILE_NAME, SHA256 } from "./manifest.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";

export const DISCOVERY_PORT = 9001, SYNC_PORT = 9002;


/** loopback, RFC 1918, link-local, CGNAT (also IPv4-mapped IPv6) */
export function isPrivate(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  if (a === "::1") return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return /^fe80:/i.test(a) || /^f[cd]/i.test(a);
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}

export interface SyncOptions { sessionsDir: string; livePort: number; syncPort?: number; log?: (s: string) => void }

export function startDiscovery(livePort: number, syncPort: number, log: (s: string) => void) {
  const sock = createSocket({ type: "udp4", reuseAddr: true });
  const name = hostname();
  sock.on("message", (msg, r) => {
    if (!isPrivate(r.address) || !msg.toString().startsWith("SLEEPLOGGER? 1")) return;
    sock.send(`SLEEPLOGGER 1 ${livePort} ${syncPort} ${name}`, r.port, r.address);
  });
  sock.on("error", (e) => log(`discovery UDP ${DISCOVERY_PORT}: ${e.message}`));
  sock.bind(DISCOVERY_PORT, "0.0.0.0");
  return sock;
}

function localFiles(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!FILE_NAME.test(f) || f.endsWith(".part")) continue;
    const st = statSync(join(dir, f));
    if (st.isFile()) out[f] = st.size;
  }
  return out;
}

export function syncHandler(sessionsDir: string, log: (s: string) => void) {
  const send = (res: ServerResponse, code: number, body: unknown) => {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!isPrivate(req.socket.remoteAddress)) return send(res, 403, { error: "private networks only" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
      if (parts[0] !== "sessions" || !SESSION_NAME.test(parts[1] ?? "")) return send(res, 404, { error: "not found" });
      const dir = join(sessionsDir, parts[1]);
      if (req.method === "GET" && parts.length === 2) {
        const files = localFiles(dir);
        if (url.searchParams.get("hashes") !== "1") return send(res, 200, { files });
        const sha256: Record<string, string> = {};
        for (const name of Object.keys(files)) {
          const digest = await digestFile(join(dir, name));
          sha256[name] = digest.sha256;
          files[name] = digest.bytes;
        }
        return send(res, 200, { files, sha256 });
      }
      if (req.method !== "PUT" || parts.length !== 3 || !FILE_NAME.test(parts[2]) || parts[2].endsWith(".part")) {
        return send(res, 405, { error: "method not allowed" });
      }
      const length = Number(req.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length < 0) return send(res, 411, { error: "Content-Length required" });
      const expected = req.headers["x-content-sha256"];
      if (expected !== undefined && (typeof expected !== "string" || !SHA256.test(expected))) {
        return send(res, 400, { error: "Invalid SHA-256 digest" });
      }
      mkdirSync(dir, { recursive: true });
      const target = join(dir, parts[2]), tmp = join(dir, `.${randomUUID()}.part`);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        const meter = new Transform({ transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk); bytes += chunk.length; cb(null, chunk);
        } });
        await pipeline(req, meter, createWriteStream(tmp, { flags: "wx", flush: true }));
        const sha256 = hash.digest("hex");
        if (bytes !== length || (expected && expected !== sha256)) {
          return send(res, 400, { error: "Recording size or SHA-256 mismatch" });
        }
        renameSync(tmp, target);
        log(`sync: ${parts[1]}/${parts[2]} ${(bytes / 1e6).toFixed(1)} MB`);
        send(res, 200, { size: bytes, sha256 });
      } finally { rmSync(tmp, { force: true }); }
    } catch (e) {
      const error = (e as Error).message;
      log(`sync failed: ${error}`);
      send(res, 400, { error });
    }
  };
}

export function startSyncServer(o: SyncOptions) {
  const log = o.log ?? console.log;
  const syncPort = o.syncPort ?? SYNC_PORT;
  const srv = createServer(syncHandler(o.sessionsDir, log));
  srv.requestTimeout = 0;   // a night of PPG takes minutes over the watch's Wi-Fi
  srv.on("error", (e) => log(`sync HTTP ${syncPort}: ${e.message}`));
  srv.listen(syncPort, "0.0.0.0");
  const udp = startDiscovery(o.livePort, syncPort, log);
  return { close: () => { srv.close(); udp.close(); } };
}
