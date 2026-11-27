import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

export const EMPTY_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

export function readDeployConfig(text) {
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object")
    throw new Error("Invalid Wrangler configuration");
  return config;
}

export function isDatabaseId(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    ) &&
    value !== EMPTY_DATABASE_ID
  );
}

export function validateDeployConfig(
  config,
  { allowUnprovisioned = false } = {},
) {
  const url = new URL(config.vars?.APP_URL);
  if (
    url.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.hostname === "example.com" ||
    url.hostname.endsWith(".example.com") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "Set APP_URL to your actual HTTPS origin before deploying.",
    );
  const databases = config.d1_databases?.filter((db) => db.binding === "DB");
  const buckets = config.r2_buckets?.filter(
    (bucket) => bucket.binding === "FIT_BUCKET",
  );
  if (
    databases?.length !== 1 ||
    !databases[0].database_name ||
    (!isDatabaseId(databases[0].database_id) &&
      !(
        allowUnprovisioned &&
        (!databases[0].database_id ||
          databases[0].database_id === EMPTY_DATABASE_ID)
      ))
  )
    throw new Error(
      "Provision D1 and set its real database_id before deploying.",
    );
  if (
    buckets?.length !== 1 ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(buckets[0].bucket_name)
  )
    throw new Error("Set a valid private R2 bucket name for FIT_BUCKET.");
  if (
    !["CN", "GLOBAL"].includes(config.vars.GARMIN_REGION) ||
    !["personal_api", "credentials"].includes(config.vars.GARMIN_AUTH_MODE)
  )
    throw new Error("Invalid Garmin mode or region.");
}

if (import.meta.main) {
  validateDeployConfig(
    readDeployConfig(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ),
  );
  console.log(
    "Deployment configuration validated. Ensure all required Worker Secrets are provisioned.",
  );
}
