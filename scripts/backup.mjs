import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { options, configuration, wrangler } from "./storage-common.mjs";

process.umask(0o077);
const target = options();
const { bucket } = configuration();
const directory = resolve(
  target.output ||
    `.wrangler/backups/${new Date().toISOString().replaceAll(":", "-")}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sql = join(directory, "database.sql");
// Do not overwrite an existing backup directory.
writeFileSync(sql, "", { flag: "wx", mode: 0o600 });
wrangler(["d1", "export", "DB", "--output", sql], target);
chmodSync(sql, 0o600);
const snapshot = new DatabaseSync(":memory:");
snapshot.exec(readFileSync(sql, "utf8"));
const objects = snapshot
  .prepare(
    "SELECT r2_key,sha256,size_bytes FROM activity_files WHERE status='ready'",
  )
  .all();
mkdirSync(join(directory, "files"), { mode: 0o700 });
for (const object of objects) {
  if (
    !/^[a-f0-9]{64}$/.test(object.sha256) ||
    typeof object.r2_key !== "string"
  )
    throw new Error("Invalid file manifest");
  const file = join(directory, "files", object.sha256 + ".fit");
  wrangler(
    ["r2", "object", "get", bucket + "/" + object.r2_key, "--file", file],
    target,
  );
  chmodSync(file, 0o600);
  const bytes = readFileSync(file);
  if (
    bytes.length !== object.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== object.sha256
  )
    throw new Error("Backup object integrity check failed");
}
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(
    {
      version: 1,
      createdAt: new Date().toISOString(),
      databaseSha256: createHash("sha256")
        .update(readFileSync(sql))
        .digest("hex"),
      objects,
    },
    null,
    2,
  ),
  { flag: "wx", mode: 0o600 },
);
snapshot.close();
console.log(
  `Backup verified: ${objects.length} objects. Directory: ${directory}`,
);
