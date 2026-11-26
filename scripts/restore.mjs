import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { options, configuration, wrangler } from "./storage-common.mjs";

process.umask(0o077);
const target = options();
if (!target.from) throw new Error("Specify --from backup-directory");
const directory = resolve(target.from);
const { bucket } = configuration();
const manifest = JSON.parse(
  readFileSync(join(directory, "manifest.json"), "utf8"),
);
const database = readFileSync(join(directory, "database.sql"));
if (
  manifest.version !== 1 ||
  !Array.isArray(manifest.objects) ||
  createHash("sha256").update(database).digest("hex") !==
    manifest.databaseSha256
)
  throw new Error("Invalid backup manifest or database checksum");
const result = JSON.parse(
  wrangler(
    [
      "d1",
      "execute",
      "DB",
      "--command",
      "SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations'",
      "--json",
    ],
    target,
  ),
);
if (result[0]?.results?.[0]?.n !== 0)
  throw new Error(
    "Restore requires an empty target database; refusing to overwrite",
  );
for (const object of manifest.objects) {
  if (
    !/^[a-f0-9]{64}$/.test(object.sha256) ||
    typeof object.r2_key !== "string" ||
    !object.r2_key.startsWith("health/")
  )
    throw new Error("Invalid backup object");
  const file = join(directory, "files", object.sha256 + ".fit");
  const bytes = readFileSync(file);
  if (
    bytes.length !== object.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== object.sha256
  )
    throw new Error("Backup object integrity check failed");
}
for (const object of manifest.objects)
  wrangler(
    [
      "r2",
      "object",
      "put",
      bucket + "/" + object.r2_key,
      "--file",
      join(directory, "files", object.sha256 + ".fit"),
      "--content-type",
      "application/octet-stream",
    ],
    target,
  );
mkdirSync(new URL("../.wrangler/", import.meta.url), { recursive: true });
const file = new URL(
  `../.wrangler/restore-${randomUUID()}.sql`,
  import.meta.url,
);
// Restoring a backup must not resurrect old browser sessions or revoked tokens.
writeFileSync(
  file,
  database.toString("utf8") +
    "\nDELETE FROM oauthAccessToken;\nDELETE FROM oauthRefreshToken;\nDELETE FROM verification;\nDELETE FROM session;\n",
  { mode: 0o600, flag: "wx" },
);
try {
  wrangler(["d1", "execute", "DB", "--file", file.pathname], target);
} finally {
  unlinkSync(file);
}
console.log(
  `Restore completed: ${manifest.objects.length} objects. Sessions and OAuth tokens were invalidated. Restore the independent provider encryption key before reconnecting.`,
);
