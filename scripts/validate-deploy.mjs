import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
const errors = [];
const config = parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  errors,
  { allowTrailingComma: true },
);
if (errors.length) throw new Error("Invalid Wrangler configuration");
const url = new URL(config.vars.APP_URL);
if (
  url.protocol !== "https:" ||
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.hostname.endsWith(".example.com") ||
  url.pathname !== "/" ||
  url.username ||
  url.password
)
  throw new Error("Set APP_URL to your actual HTTPS origin before deploying.");
if (
  !config.d1_databases?.find(
    (db) =>
      db.binding === "DB" &&
      /^[a-f0-9-]{36}$/i.test(db.database_id) &&
      db.database_id !== "00000000-0000-0000-0000-000000000000",
  )
)
  throw new Error(
    "Provision D1 and set its real database_id before deploying.",
  );
new Intl.DateTimeFormat("en-CA", { timeZone: config.vars.APP_TIMEZONE });
if (
  !["CN", "GLOBAL"].includes(config.vars.GARMIN_REGION) ||
  !["personal_api", "credentials"].includes(config.vars.GARMIN_AUTH_MODE)
)
  throw new Error("Invalid Garmin mode or region.");
console.log(
  "Deployment configuration validated. Ensure all required Worker Secrets are provisioned.",
);
