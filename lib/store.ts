/**
 * Durable document store (W1.4) — the single source of truth for Merit's local JSON state, with an optional
 * Postgres/Supabase mirror so state survives a stateless redeploy (an ephemeral disk).
 *
 * The LOCAL FILE is always the primary, synchronous read path (atomic write to MERIT_DATA_DIR/<name>.json) —
 * unchanged behavior, and durable on its own when MERIT_DATA_DIR points at a mounted volume. When
 * MERIT_STORE=supabase and a client is configured (lib/db.ts), every save ALSO fires a best-effort async
 * upsert into a `merit_documents` table, and hydrateDoc() pulls a missing document back on boot. This keeps
 * the hot path sync + fast while giving stateless hosts (Render/Fly without a disk) real durability — a
 * graceful drop-in that is a complete no-op until the env is set.
 *
 * Supabase table (create when enabling the mirror):
 *   create table merit_documents (name text primary key, data jsonb not null, updated_at timestamptz);
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "./db";

/** The data directory — read lazily (never at module load) so tests can point it at a temp dir. On serverless
 *  (Vercel / Lambda / Netlify) the working dir is READ-ONLY except /tmp, so cwd/.data writes EROFS-fail; we
 *  fall back to /tmp/merit-data (writable, persists within a warm instance). Use MERIT_STORE=supabase for
 *  durability across cold starts. */
export function dataDir(): string {
  if (process.env.MERIT_DATA_DIR) return process.env.MERIT_DATA_DIR;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY) {
    return path.join("/tmp", "merit-data");
  }
  return path.join(process.cwd(), ".data");
}

export function docPath(name: string): string {
  return path.join(dataDir(), `${name}.json`);
}

/** Load a JSON document by name from the local store (sync, the primary read path). Returns `fallback` when
 *  the document is absent or unreadable (e.g. a partially-written/corrupt file). */
export function loadDoc<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(docPath(name), "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Persist a JSON document atomically (sync), and — when the Supabase mirror is enabled — fire a best-effort
 *  async upsert so the document survives a redeploy that loses the disk. Never throws into a run. */
export function saveDoc(name: string, obj: unknown): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const file = docPath(name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file); // atomic — a reader never sees a truncated file
  } catch (e) {
    console.error(`[store] save ${name} failed:`, (e as Error).message);
  }
  void mirrorSave(name, obj);
}

function mirrorEnabled(): boolean {
  return (process.env.MERIT_STORE || "").toLowerCase() === "supabase";
}

async function mirrorSave(name: string, obj: unknown): Promise<void> {
  if (!mirrorEnabled()) return;
  const c = db();
  if (!c) return;
  try {
    await c
      .from("merit_documents")
      .upsert({ name, data: obj, updated_at: new Date().toISOString() }, { onConflict: "name" });
  } catch (e) {
    console.error(`[store] mirror ${name} failed:`, (e as Error).message);
  }
}

/** Boot hydration: when the mirror is enabled and the LOCAL file is missing, pull the mirrored document and
 *  write it locally so the sync read path is seeded after a redeploy that lost the disk. Returns true when it
 *  actually hydrated a document. Best-effort; never throws. */
export async function hydrateDoc(name: string): Promise<boolean> {
  if (!mirrorEnabled()) return false;
  try {
    if (fs.existsSync(docPath(name))) return false; // a local copy already exists — nothing to restore
    const c = db();
    if (!c) return false;
    const { data, error } = await c.from("merit_documents").select("data").eq("name", name).maybeSingle();
    if (error || !data?.data) return false;
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(docPath(name), JSON.stringify(data.data, null, 2));
    return true;
  } catch (e) {
    console.error(`[store] hydrate ${name} failed:`, (e as Error).message);
    return false;
  }
}
