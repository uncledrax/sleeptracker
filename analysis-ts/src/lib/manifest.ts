import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

export const MANIFEST = "session_manifest.json";
export const SESSION_NAME = /^\d{8}_\d{6}$/;
export const FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export interface FileDigest { bytes: number; sha256: string }
export type Digests = Record<string, FileDigest>;

export async function digestFile(path: string): Promise<FileDigest> {
  let bytes = 0;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}

export function parseManifest(raw: string, session: string): Digests {
  const m = JSON.parse(raw);
  if (m.version !== 1 || m.session !== session || !m.files || typeof m.files !== "object" ||
      Array.isArray(m.files) || !Object.hasOwn(m.files, "session.json") || Object.hasOwn(m.files, MANIFEST)) {
    throw new Error(`Invalid recording manifest in ${session}`);
  }
  for (const [name, value] of Object.entries(m.files)) {
    const d = value as FileDigest | null;
    if (!FILE_NAME.test(name) || !d || !Number.isSafeInteger(d.bytes) || d.bytes < 0 || !SHA256.test(d.sha256)) {
      throw new Error(`Invalid manifest entry in ${session}: ${name}`);
    }
  }
  return { ...m.files, [MANIFEST]: { bytes: Buffer.byteLength(raw), sha256: createHash("sha256").update(raw).digest("hex") } };
}

/** Extra PC analysis outputs are allowed. Only the files sealed by the watch are verified. */
export async function digestDifferences(dir: string, expected: Digests): Promise<string[]> {
  const bad: string[] = [];
  for (const [name, d] of Object.entries(expected)) {
    try {
      const local = await digestFile(join(dir, name));
      if (local.bytes !== d.bytes || local.sha256 !== d.sha256) bad.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      bad.push(name);
    }
  }
  return bad;
}
