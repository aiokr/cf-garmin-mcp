import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hashPassword } from "better-auth/crypto";

const target = process.argv.slice(2);
if (target.length !== 1 || !["--local", "--remote"].includes(target[0])) {
  console.error(
    "Usage: pnpm owner:recover --local|--remote < protected-password.json",
  );
  process.exit(1);
}
const input = JSON.parse(readFileSync(0, "utf8"));
if (
  typeof input.password !== "string" ||
  input.password.length < 12 ||
  input.password.length > 128
)
  throw new Error("Password must contain 12–128 characters.");
const hash = await hashPassword(input.password);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
mkdirSync(new URL("../.wrangler/", import.meta.url), { recursive: true });
const file = new URL(
  `../.wrangler/recover-${randomUUID()}.sql`,
  import.meta.url,
);
// End sessions before replacing the password. Run while the instance is under
// maintenance; no HTTP recovery endpoint or reusable recovery token is exposed.
writeFileSync(
  file,
  `DELETE FROM session WHERE "userId" = (SELECT owner_user_id FROM instance_state WHERE id=1);\nUPDATE account SET password=${quote(hash)}, "updatedAt"=${Date.now()} WHERE "providerId"='credential' AND "userId"=(SELECT owner_user_id FROM instance_state WHERE id=1);\n`,
  { mode: 0o600, flag: "wx" },
);
try {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      target[0],
      "--file",
      file.pathname,
    ],
    { stdio: "inherit", cwd: new URL("..", import.meta.url) },
  );
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(file);
}
