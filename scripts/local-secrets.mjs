import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const content = `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\nPROVIDER_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\n`;
try {
  writeFileSync(new URL("../.dev.vars", import.meta.url), content, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Created .dev.vars (0600). Open the app immediately to create the sole Owner; no initialization key is needed.",
  );
} catch (error) {
  if (error.code === "EEXIST")
    console.error(".dev.vars already exists; refusing to replace secrets.");
  else console.error("Unable to create local secrets.");
  process.exitCode = 1;
}
