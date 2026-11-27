import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { applyEdits, modify } from "jsonc-parser";
import {
  isDatabaseId,
  readDeployConfig,
  validateDeployConfig,
} from "./validate-deploy.mjs";

export class CloudflareApiError extends Error {
  constructor(resource, status, codes = []) {
    super(
      `Cloudflare ${resource} failed (HTTP ${status}; codes ${codes.join(",") || "unknown"}). Check the build API token permissions, account quota and R2 activation.`,
    );
    this.status = status;
    this.codes = codes;
  }
}

export function cloudflareApi({
  accountId,
  apiToken,
  fetch = globalThis.fetch,
}) {
  return async (resource, { method = "GET", body, jurisdiction } = {}) => {
    let response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}${resource}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${apiToken}`,
            ...(body instanceof globalThis.FormData
              ? {}
              : { "Content-Type": "application/json" }),
            ...(jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {}),
          },
          ...(body
            ? {
                body:
                  body instanceof globalThis.FormData
                    ? body
                    : JSON.stringify(body),
              }
            : {}),
          redirect: "error",
          signal: globalThis.AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new Error(
        `Cloudflare ${resource} request failed. Check network connectivity and retry.`,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CloudflareApiError(resource, response.status);
    }
    if (!response.ok || payload.success !== true) {
      const codes = (payload.errors || [])
        .map((error) => error.code)
        .filter(Number.isInteger);
      throw new CloudflareApiError(resource, response.status, codes);
    }
    return payload.result;
  };
}

function missingResource(error, code) {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 404 || error.codes.includes(code))
  );
}

async function findDatabase(api, name) {
  for (let page = 1; ; page++) {
    const results = await api(
      `/d1/database?name=${encodeURIComponent(name)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(results))
      throw new Error("Invalid D1 database listing response.");
    const exact = results.filter((database) => database.name === name);
    if (exact.length > 1)
      throw new Error(
        "Multiple D1 databases match database_name; configure an explicit database_id.",
      );
    if (exact.length) return exact[0];
    if (results.length < 100) return null;
  }
}

const GARMIN_SECRETS = [
  "GARMIN_EMAIL",
  "GARMIN_PASSWORD",
  "GARMIN_PERSONAL_API_KEY",
];
const INTERNAL_SECRETS = ["BETTER_AUTH_SECRET", "PROVIDER_ENCRYPTION_KEY"];

// The API lists names/types only, never secret values. Existing secrets are authoritative:
// ignore build-time replacements so upgrades cannot silently invalidate encrypted data.
export async function prepareWorkerSecrets({
  config,
  env,
  api,
  log = () => {},
}) {
  const script = "/workers/scripts/" + encodeURIComponent(config.name);
  const secretPath = script + "/secrets";
  let existing;
  let workerMissing = false;
  try {
    existing = await api(secretPath);
  } catch (error) {
    if (!missingResource(error, 10007)) throw error;
    workerMissing = true;
    existing = [];
  }
  const namesOf = (secrets) => {
    if (
      !Array.isArray(secrets) ||
      secrets.some(
        (item) => typeof item.name !== "string" || item.type !== "secret_text",
      )
    )
      throw new Error(
        "Invalid Worker secret names response; refusing to replace secrets.",
      );
    return new Set(secrets.map((item) => item.name));
  };
  const names = namesOf(existing);
  const supplied = (name) =>
    typeof env[name] === "string" && env[name].length > 0;
  const available = (name) => names.has(name) || supplied(name);
  const required =
    config.vars.GARMIN_AUTH_MODE === "personal_api"
      ? ["GARMIN_PERSONAL_API_KEY"]
      : ["GARMIN_EMAIL", "GARMIN_PASSWORD"];
  const unwanted = GARMIN_SECRETS.filter((name) => !required.includes(name));
  if (unwanted.some(available))
    throw new Error(
      "Garmin credentials conflict: choose GARMIN_AUTH_MODE=credentials with GARMIN_EMAIL + GARMIN_PASSWORD, OR personal_api with GARMIN_PERSONAL_API_KEY. Remove the other group's Worker/build secrets before deploying.",
    );
  if (!required.every(available))
    throw new Error(
      "Configure Garmin before deploying: GARMIN_AUTH_MODE=" +
        config.vars.GARMIN_AUTH_MODE +
        " requires " +
        required.join(" + ") +
        ". Set these as Worker Secrets (or build Secrets for first deployment); leave the other Garmin group empty. Set GARMIN_REGION to CN or GLOBAL.",
    );
  if (workerMissing) {
    // Same multipart upload contract as Wrangler's createDraftWorker. Never upload a
    // placeholder for an existing Worker, including on permission/network errors.
    const body = new globalThis.FormData();
    body.set(
      "metadata",
      JSON.stringify({
        main_module: "bootstrap.mjs",
        compatibility_date: config.compatibility_date,
        bindings: [],
        observability: { enabled: false },
      }),
    );
    body.set(
      "bootstrap.mjs",
      new globalThis.Blob(
        [
          'export default { fetch() { return new Response("Deployment in progress", { status: 503, headers: { "Cache-Control": "no-store" } }); } };',
        ],
        { type: "application/javascript+module" },
      ),
      "bootstrap.mjs",
    );
    await api(script, { method: "PUT", body });
    log(
      "Created fail-closed placeholder Worker for initial secret provisioning.",
    );
  }
  for (const name of [...INTERNAL_SECRETS, ...required]) {
    if (names.has(name)) continue;
    const text =
      name === "BETTER_AUTH_SECRET"
        ? randomBytes(32).toString("hex")
        : name === "PROVIDER_ENCRYPTION_KEY"
          ? randomBytes(32).toString("base64")
          : env[name];
    await api(secretPath, {
      method: "PUT",
      body: { name, text, type: "secret_text" },
    });
    names.add(name);
    log("Persisted missing Worker Secret: " + name + ".");
  }
  const confirmed = namesOf(await api(secretPath));
  if (
    ![...INTERNAL_SECRETS, ...required].every((name) => confirmed.has(name)) ||
    unwanted.some((name) => confirmed.has(name))
  )
    throw new Error(
      "Worker secret name verification failed. Check Variables & Secrets and retry; no secret values were read.",
    );
  log(
    "Worker secret names verified; existing keys preserved. Garmin mode: " +
      config.vars.GARMIN_AUTH_MODE +
      ".",
  );
}

// Called before migrations: never publish a Worker with an uninitialized database.
export async function prepareDeploy({ text, env = {}, api, log = () => {} }) {
  let config = readDeployConfig(text);
  const patch = (path, value) => {
    text = applyEdits(
      text,
      modify(text, path, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
    config = readDeployConfig(text);
  };
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || config.account_id;
  if (!/^[a-f0-9]{32}$/i.test(accountId || ""))
    throw new Error(
      "Set CLOUDFLARE_ACCOUNT_ID in Workers Builds (or account_id in wrangler.jsonc).",
    );
  if (!api) {
    if (!env.CLOUDFLARE_API_TOKEN)
      throw new Error(
        "Workers Builds must provide CLOUDFLARE_API_TOKEN with D1 Write, Workers R2 Storage Write and Workers Scripts Write permissions.",
      );
    api = cloudflareApi({ accountId, apiToken: env.CLOUDFLARE_API_TOKEN });
  }
  if (config.account_id && config.account_id !== accountId)
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID does not match the configured account_id.",
    );
  patch(["account_id"], accountId);
  if (env.WRANGLER_CI_OVERRIDE_NAME)
    patch(["name"], env.WRANGLER_CI_OVERRIDE_NAME);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name || ""))
    throw new Error("Set a valid Worker name before deploying.");
  for (const name of [
    "APP_URL",
    "PROVIDER_KEY_VERSION",
    "GARMIN_AUTH_MODE",
    "GARMIN_REGION",
  ]) {
    if (env[name]) patch(["vars", name], env[name]);
  }
  // An explicit production origin is preserved; only the local default is derived.
  if (config.vars?.APP_URL === "http://localhost:8787") {
    if (config.workers_dev === false)
      throw new Error("Set APP_URL explicitly when workers_dev is disabled.");
    const { subdomain } = await api("/workers/subdomain");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(subdomain || ""))
      throw new Error(
        "Enable a workers.dev subdomain in Cloudflare or set an explicit HTTPS APP_URL.",
      );
    patch(
      ["vars", "APP_URL"],
      `https://${config.name}.${subdomain}.workers.dev`,
    );
  }
  validateDeployConfig(config, { allowUnprovisioned: true });
  const databaseIndex = config.d1_databases.findIndex(
    (item) => item.binding === "DB",
  );
  const databaseBinding = config.d1_databases[databaseIndex];
  let database;
  if (isDatabaseId(databaseBinding.database_id)) {
    // An explicit UUID is authoritative. Never silently replace a deleted database.
    database = await api(`/d1/database/${databaseBinding.database_id}`);
    if (database.uuid !== databaseBinding.database_id)
      throw new Error(
        "D1 database response does not match the configured database_id.",
      );
  } else {
    database = await findDatabase(api, databaseBinding.database_name);
    if (!database) {
      database = await api("/d1/database", {
        method: "POST",
        body: {
          name: databaseBinding.database_name,
          ...(databaseBinding.jurisdiction
            ? { jurisdiction: databaseBinding.jurisdiction }
            : {}),
        },
      });
      log("Created D1 database for DB.");
    } else log("Reusing D1 database matching database_name.");
  }
  if (
    !isDatabaseId(database.uuid) ||
    database.name !== databaseBinding.database_name
  )
    throw new Error(
      "D1 database UUID/name is invalid or does not match the configured binding.",
    );
  if (
    databaseBinding.jurisdiction &&
    database.jurisdiction !== databaseBinding.jurisdiction
  )
    throw new Error(
      "D1 database jurisdiction does not match the configured binding.",
    );
  patch(["d1_databases", databaseIndex, "database_id"], database.uuid);

  const bucketBinding = config.r2_buckets.find(
    (item) => item.binding === "FIT_BUCKET",
  );
  const bucketPath = `/r2/buckets/${encodeURIComponent(bucketBinding.bucket_name)}`;
  const options = { jurisdiction: bucketBinding.jurisdiction };
  try {
    await api(bucketPath, options);
    log("Reusing R2 bucket configured for FIT_BUCKET.");
  } catch (error) {
    if (!missingResource(error, 10006)) throw error;
    await api("/r2/buckets", {
      ...options,
      method: "POST",
      body: { name: bucketBinding.bucket_name },
    });
    log("Created private R2 bucket for FIT_BUCKET.");
  }
  const managed = await api(`${bucketPath}/domains/managed`, options);
  const custom = await api(`${bucketPath}/domains/custom`, options);
  if (
    managed.enabled !== false ||
    !Array.isArray(custom.domains) ||
    custom.domains.some((domain) => domain.enabled !== false)
  )
    throw new Error(
      "FIT_BUCKET must be private. Disable its r2.dev and public custom domains before retrying.",
    );
  validateDeployConfig(config);
  await prepareWorkerSecrets({ config, env, api, log });
  log(`Deployment resources ready. APP_URL=${config.vars.APP_URL}`);
  return text;
}

if (import.meta.main) {
  if (
    process.argv.includes("--provision") ||
    process.env.WORKERS_CI ||
    process.env.WRANGLER_CI_OVERRIDE_NAME
  ) {
    try {
      const path = new URL("../wrangler.jsonc", import.meta.url);
      const text = await prepareDeploy({
        text: readFileSync(path, "utf8"),
        env: process.env,
        log: console.log,
      });
      writeFileSync(path, text);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else
    console.log(
      "CLI deployment: using configured resources and existing Worker Secrets. Run pnpm run deploy:prepare with an API token to provision missing internal keys and validate Garmin secret names before first deployment.",
    );
}
