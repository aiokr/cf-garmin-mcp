import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { parseFit } from "./fit";

// Bounded scans resume on later weekly runs. Previous immutable versions are
// retained; repair never deletes user data or assumes a cross-storage transaction.
export async function repairArchives(env: Env) {
  const saved = await env.DB.prepare(
    "SELECT value FROM maintenance_state WHERE key='archive-cursors'",
  ).first<{ value: string }>();
  const cursor = JSON.parse(saved?.value || "{}") as {
    fileId?: string;
    r2?: string;
  };
  let missing = 0;
  let recovered = 0;
  let unindexed = 0;
  const files = await env.DB.prepare(
    "SELECT id,r2_key,size_bytes,sha256 FROM activity_files WHERE status='ready' AND id>? ORDER BY id LIMIT 20",
  )
    .bind(cursor.fileId || "")
    .all<{ id: string; r2_key: string; size_bytes: number; sha256: string }>();
  for (const file of files.results) {
    const object = await env.FIT_BUCKET.head(file.r2_key);
    if (
      !object ||
      object.size !== file.size_bytes ||
      (object.customMetadata?.sha256 !== undefined &&
        object.customMetadata.sha256 !== file.sha256)
    ) {
      await env.DB.prepare(
        "UPDATE activity_files SET status='error',error_code='R2_OBJECT_MISSING' WHERE id=?",
      )
        .bind(file.id)
        .run();
      missing++;
    }
  }
  const objects = await env.FIT_BUCKET.list({
    prefix: "health/",
    limit: 20,
    cursor: cursor.r2,
  });
  for (const object of objects.objects) {
    if (
      await env.DB.prepare("SELECT id FROM activity_files WHERE r2_key=?")
        .bind(object.key)
        .first()
    )
      continue;
    const parts =
      /^health\/([^/]+)\/([^/]+)\/activities\/(\d+)\/([a-f0-9]{64})\.fit$/.exec(
        object.key,
      );
    if (!parts) {
      unindexed++;
      continue;
    }
    const file = await env.DB.prepare(
      "SELECT f.id FROM activity_files f JOIN activities a ON a.id=f.activity_id JOIN provider_connections c ON c.id=a.connection_id WHERE c.user_id=? AND c.id=? AND a.external_activity_id=? AND f.status<>'ready'",
    )
      .bind(parts[1], parts[2], parts[3])
      .first<{ id: string }>();
    if (
      !file ||
      recovered >= 3 ||
      object.size >
        Math.min(Number(env.MAX_FIT_BYTES) || 16_777_216, 33_554_432)
    ) {
      unindexed++;
      continue;
    }
    const stored = await env.FIT_BUCKET.get(object.key);
    if (!stored) continue;
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if ((await sha256(bytes)) !== parts[4]) {
      unindexed++;
      continue;
    }
    try {
      await parseFit(bytes, 10);
    } catch {
      unindexed++;
      continue;
    }
    await env.DB.prepare(
      "UPDATE activity_files SET r2_key=?,sha256=?,size_bytes=?,status='ready',error_code=NULL WHERE id=? AND status<>'ready'",
    )
      .bind(object.key, parts[4], bytes.length, file.id)
      .run();
    recovered++;
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO maintenance_state VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(
      "archive-cursors",
      JSON.stringify({
        fileId: files.results.length === 20 ? files.results.at(-1)!.id : "",
        r2: objects.truncated ? objects.cursor : undefined,
      }),
      now,
    ),
    env.DB.prepare(
      "INSERT INTO maintenance_state VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(
      "archive-health",
      JSON.stringify({
        checked: files.results.length,
        missing,
        recovered,
        unindexed,
      }),
      now,
    ),
  ]);
  return { checked: files.results.length, missing, recovered, unindexed };
}
