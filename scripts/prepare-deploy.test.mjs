import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CloudflareApiError,
  cloudflareApi,
  prepareDeploy,
  prepareWorkerSecrets,
} from "./prepare-deploy.mjs";
import { readDeployConfig, validateDeployConfig } from "./validate-deploy.mjs";

const template = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);
const accountId = "a".repeat(32);
const databaseId = "11111111-1111-4111-8111-111111111111";
const env = { CLOUDFLARE_ACCOUNT_ID: accountId };

function cloud({
  database = null,
  bucketExists = false,
  publicManaged = false,
  domains = [],
  failAt,
  jurisdiction,
  workerExists = true,
  secrets = [
    "BETTER_AUTH_SECRET",
    "PROVIDER_ENCRYPTION_KEY",
    "GARMIN_EMAIL",
    "GARMIN_PASSWORD",
  ],
} = {}) {
  const calls = [];
  const secretNames = new Set(secrets);
  const api = async (resource, options = {}) => {
    const method = options.method || "GET";
    calls.push({ resource, method, ...options });
    if (resource === failAt)
      throw new CloudflareApiError(resource, 403, [10000]);
    if (resource === "/workers/subdomain") return { subdomain: "test-account" };
    if (resource.startsWith("/workers/scripts/")) {
      if (resource.endsWith("/secrets")) {
        if (!workerExists) throw new CloudflareApiError(resource, 404, [10007]);
        if (method === "PUT") secretNames.add(options.body.name);
        return [...secretNames].map((name) => ({ name, type: "secret_text" }));
      }
      assert.equal(method, "PUT");
      assert.equal(
        workerExists,
        false,
        "must never replace a live Worker with placeholder",
      );
      assert.ok(options.body instanceof globalThis.FormData);
      workerExists = true;
      return {};
    }
    if (resource.startsWith("/d1/database?")) return database ? [database] : [];
    if (resource === "/d1/database" && method === "POST") {
      database = {
        uuid: databaseId,
        name: options.body.name,
        jurisdiction: options.body.jurisdiction,
      };
      return database;
    }
    if (resource.startsWith("/d1/database/")) {
      if (!database) throw new CloudflareApiError(resource, 404, [7404]);
      return database;
    }
    if (resource === "/r2/buckets" && method === "POST") {
      bucketExists = true;
      return { name: options.body.name };
    }
    if (resource.endsWith("/domains/managed"))
      return { enabled: publicManaged };
    if (resource.endsWith("/domains/custom")) return { domains };
    if (resource.startsWith("/r2/buckets/")) {
      assert.equal(options.jurisdiction, jurisdiction);
      if (!bucketExists) throw new CloudflareApiError(resource, 404, [10006]);
      return { name: resource.split("/").at(-1) };
    }
    throw new Error(`Unexpected mocked request: ${method} ${resource}`);
  };
  return { api, calls };
}

function fixture(update) {
  const config = readDeployConfig(template);
  update(config);
  return JSON.stringify(config);
}

test("new account creates D1 and private R2, resolves origin and preserves unrelated bindings", async () => {
  const mock = cloud();
  const text = await prepareDeploy({ text: template, env, api: mock.api });
  const config = readDeployConfig(text);
  validateDeployConfig(config);
  assert.equal(config.account_id, accountId);
  assert.equal(
    config.vars.APP_URL,
    "https://cf-garmin-mcp.test-account.workers.dev",
  );
  assert.equal(config.d1_databases[0].database_id, databaseId);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].migrations_dir, "apps/worker/migrations");
  assert.equal(config.r2_buckets[0].binding, "FIT_BUCKET");
  assert.deepEqual(
    config.durable_objects,
    readDeployConfig(template).durable_objects,
  );
  assert.deepEqual(config.workflows, readDeployConfig(template).workflows);
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 2);
  assert.equal(
    mock.calls.some((call) => call.method === "DELETE"),
    false,
  );
});

test("repeated builds recover the same resources from names even with an unchanged source config", async () => {
  const mock = cloud();
  const first = await prepareDeploy({ text: template, env, api: mock.api });
  const second = await prepareDeploy({ text: template, env, api: mock.api });
  assert.equal(first, second);
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 2);
  await prepareDeploy({ text: second, env, api: mock.api });
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 2);
});

test("platform-provisioned resources and renamed resources are reused without new creation", async () => {
  const text = fixture((config) => {
    config.d1_databases[0].database_name = "my-private-database";
    config.d1_databases[0].database_id = databaseId;
    config.r2_buckets[0].bucket_name = "my-private-files";
  });
  const mock = cloud({
    database: { uuid: databaseId, name: "my-private-database" },
    bucketExists: true,
  });
  const config = readDeployConfig(
    await prepareDeploy({ text, env, api: mock.api }),
  );
  assert.equal(config.r2_buckets[0].bucket_name, "my-private-files");
  assert.equal(
    mock.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("an explicit missing UUID stops preparation instead of replacing the database", async () => {
  const text = fixture((config) => {
    config.d1_databases[0].database_id = databaseId;
  });
  const mock = cloud();
  await assert.rejects(prepareDeploy({ text, env, api: mock.api }), /HTTP 404/);
  assert.equal(
    mock.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("D1 name searches use exact matches and paginate beyond the first page", async () => {
  const mock = cloud({ bucketExists: true });
  const api = (resource, options) => {
    if (resource.startsWith("/d1/database?")) {
      if (resource.endsWith("page=1"))
        return Array.from({ length: 100 }, () => ({
          uuid: databaseId,
          name: "cf-garmin-mcp-other",
        }));
      return [{ uuid: databaseId, name: "cf-garmin-mcp" }];
    }
    return mock.api(resource, options);
  };
  const result = readDeployConfig(
    await prepareDeploy({ text: template, env, api }),
  );
  assert.equal(result.d1_databases[0].database_id, databaseId);
  assert.equal(
    mock.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("D1 permission errors abort before R2 preparation", async () => {
  const mock = cloud({ failAt: "/d1/database" });
  await assert.rejects(
    prepareDeploy({ text: template, env, api: mock.api }),
    /HTTP 403/,
  );
  assert.equal(
    mock.calls.some((call) => call.resource.startsWith("/r2/")),
    false,
  );
});

test("R2 permission errors are not treated as a missing bucket", async () => {
  const mock = cloud({ failAt: "/r2/buckets/cf-garmin-mcp-fit" });
  await assert.rejects(
    prepareDeploy({ text: template, env, api: mock.api }),
    /HTTP 403/,
  );
  assert.equal(
    mock.calls.some((call) => call.resource === "/r2/buckets"),
    false,
  );
});

for (const state of [
  { publicManaged: true },
  { domains: [{ enabled: true, domain: "files.test" }] },
]) {
  test(`public R2 access aborts preparation: ${JSON.stringify(state)}`, async () => {
    const mock = cloud(state);
    await assert.rejects(
      prepareDeploy({ text: template, env, api: mock.api }),
      /must be private/,
    );
    assert.equal(
      mock.calls.some((call) =>
        ["DELETE", "PUT", "PATCH"].includes(call.method),
      ),
      false,
    );
  });
}

test("build configuration overrides are applied without copying secrets into Wrangler vars", async () => {
  const mock = cloud({
    secrets: [
      "BETTER_AUTH_SECRET",
      "PROVIDER_ENCRYPTION_KEY",
      "GARMIN_PERSONAL_API_KEY",
    ],
  });
  const overrides = {
    ...env,
    WRANGLER_CI_OVERRIDE_NAME: "renamed-worker",
    GARMIN_AUTH_MODE: "personal_api",
    GARMIN_REGION: "GLOBAL",
    APP_TIMEZONE: "Europe/Paris",
    OSM_TILE_URL: "https://unused.test/{z}/{x}/{y}.png",
    PROVIDER_KEY_VERSION: "2",
    GARMIN_PERSONAL_API_KEY: "must-not-appear-in-config",
  };
  const text = await prepareDeploy({
    text: template,
    env: overrides,
    api: mock.api,
  });
  const config = readDeployConfig(text);
  assert.equal(config.name, "renamed-worker");
  assert.equal(
    config.vars.APP_URL,
    "https://renamed-worker.test-account.workers.dev",
  );
  assert.equal(config.vars.GARMIN_REGION, "GLOBAL");
  assert.equal(config.vars.GARMIN_AUTH_MODE, "personal_api");
  assert.equal(config.vars.APP_TIMEZONE, undefined);
  assert.equal(config.vars.OSM_TILE_URL, undefined);
  assert.equal(config.vars.PROVIDER_KEY_VERSION, "2");
  assert.equal(text.includes("must-not-appear-in-config"), false);
});

test("explicit production origin is preserved without requesting a workers.dev subdomain", async () => {
  const mock = cloud();
  const config = readDeployConfig(
    await prepareDeploy({
      text: template,
      env: { ...env, APP_URL: "https://garmin.test" },
      api: mock.api,
    }),
  );
  assert.equal(config.vars.APP_URL, "https://garmin.test");
  assert.equal(
    mock.calls.some((call) => call.resource === "/workers/subdomain"),
    false,
  );
});

test("invalid modes and malformed IDs stop before resource creation", async () => {
  for (const text of [
    fixture((config) => {
      config.vars.GARMIN_REGION = "INVALID";
    }),
    fixture((config) => {
      config.d1_databases[0].database_id = "invalid";
    }),
  ]) {
    const mock = cloud();
    await assert.rejects(prepareDeploy({ text, env, api: mock.api }));
    assert.equal(
      mock.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});

test("account mismatch and missing credentials fail before API requests", async () => {
  const mock = cloud();
  const text = fixture((config) => {
    config.account_id = "b".repeat(32);
  });
  await assert.rejects(
    prepareDeploy({ text, env, api: mock.api }),
    /does not match/,
  );
  await assert.rejects(
    prepareDeploy({ text: template, env }),
    /CLOUDFLARE_API_TOKEN/,
  );
  await assert.rejects(
    prepareDeploy({ text: template, env: {}, api: mock.api }),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.equal(mock.calls.length, 0);
});

test("API failures expose status and numeric codes without leaking token or response bodies", async () => {
  const secret = "sensitive-build-token";
  const api = cloudflareApi({
    accountId,
    apiToken: secret,
    fetch: async (url, init) => {
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
      );
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      assert.equal(init.redirect, "error");
      return new globalThis.Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: secret }],
        }),
        { status: 403 },
      );
    },
  });
  await assert.rejects(api("/d1/database"), (error) => {
    assert.match(error.message, /HTTP 403; codes 10000/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("fresh Worker gets a fail-closed placeholder then random persistent internal keys", async () => {
  const mock = cloud({ workerExists: false, secrets: [] });
  const logs = [];
  const supplied = {
    ...env,
    GARMIN_EMAIL: "private@example.test",
    GARMIN_PASSWORD: "private-password",
  };
  const text = await prepareDeploy({
    text: template,
    env: supplied,
    api: mock.api,
    log: (line) => logs.push(line),
  });
  const writes = mock.calls.filter(
    (call) => call.resource.endsWith("/secrets") && call.method === "PUT",
  );
  assert.equal(writes.length, 4);
  const auth = writes.find((call) => call.body.name === "BETTER_AUTH_SECRET")
    .body.text;
  const key = writes.find(
    (call) => call.body.name === "PROVIDER_ENCRYPTION_KEY",
  ).body.text;
  assert.match(auth, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(key, "base64").length, 32);
  assert.notEqual(auth, Buffer.from(key, "base64").toString("hex"));
  for (const value of [
    auth,
    key,
    supplied.GARMIN_EMAIL,
    supplied.GARMIN_PASSWORD,
  ]) {
    assert.equal(logs.join("\n").includes(value), false);
    assert.equal(text.includes(value), false);
  }
  const upload = mock.calls.find(
    (call) => call.body instanceof globalThis.FormData,
  );
  const metadata = JSON.parse(upload.body.get("metadata"));
  assert.equal(metadata.main_module, "bootstrap.mjs");
  assert.deepEqual(metadata.bindings, []);
  assert.match(await upload.body.get("bootstrap.mjs").text(), /status: 503/);
  assert.ok(mock.calls.indexOf(upload) < mock.calls.indexOf(writes[0]));
  await prepareDeploy({ text: template, env: supplied, api: mock.api });
  assert.equal(mock.calls.filter((call) => call.method === "PUT").length, 5);
});

test("existing internal keys and Garmin values are never overwritten, even with build replacements", async () => {
  const mock = cloud();
  await prepareDeploy({
    text: template,
    env: {
      ...env,
      BETTER_AUTH_SECRET: "do-not-replace",
      PROVIDER_ENCRYPTION_KEY: "do-not-replace",
      GARMIN_EMAIL: "replacement",
      GARMIN_PASSWORD: "replacement",
    },
    api: mock.api,
  });
  assert.equal(
    mock.calls.some((call) => call.method === "PUT"),
    false,
  );
});

test("only missing internal key is generated on an existing Worker", async () => {
  const mock = cloud({
    secrets: ["BETTER_AUTH_SECRET", "GARMIN_EMAIL", "GARMIN_PASSWORD"],
  });
  await prepareDeploy({ text: template, env, api: mock.api });
  const writes = mock.calls.filter((call) => call.method === "PUT");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.name, "PROVIDER_ENCRYPTION_KEY");
});

test("personal_api mode persists only API key and rejects credentials-mode leftovers", async () => {
  const config = readDeployConfig(template);
  config.vars.GARMIN_AUTH_MODE = "personal_api";
  const mock = cloud({ secrets: [] });
  await prepareWorkerSecrets({
    config,
    env: { GARMIN_PERSONAL_API_KEY: "private-api-key" },
    api: mock.api,
  });
  assert.deepEqual(
    mock.calls
      .filter((call) => call.method === "PUT")
      .map((call) => call.body.name),
    [
      "BETTER_AUTH_SECRET",
      "PROVIDER_ENCRYPTION_KEY",
      "GARMIN_PERSONAL_API_KEY",
    ],
  );
  const conflict = cloud();
  await assert.rejects(
    prepareWorkerSecrets({
      config,
      env: { GARMIN_PERSONAL_API_KEY: "key" },
      api: conflict.api,
    }),
    /credentials conflict/,
  );
  assert.equal(
    conflict.calls.some((call) => call.method === "PUT"),
    false,
  );
});

test("missing or mixed Garmin configuration fails before Worker or secret writes", async () => {
  for (const supplied of [
    {},
    { GARMIN_EMAIL: "email" },
    {
      GARMIN_EMAIL: "email",
      GARMIN_PASSWORD: "password",
      GARMIN_PERSONAL_API_KEY: "key",
    },
  ]) {
    const mock = cloud({ workerExists: false, secrets: [] });
    await assert.rejects(
      prepareWorkerSecrets({
        config: readDeployConfig(template),
        env: supplied,
        api: mock.api,
      }),
      /Garmin/,
    );
    assert.equal(
      mock.calls.some((call) => call.method === "PUT"),
      false,
    );
  }
});

test("secret lookup permission/network errors never create a placeholder or rotate keys", async () => {
  for (const failure of [
    new CloudflareApiError("secrets", 403, [10000]),
    new Error("network failure"),
  ]) {
    const calls = [];
    await assert.rejects(
      prepareWorkerSecrets({
        config: readDeployConfig(template),
        env: {},
        api: async (path, options = {}) => {
          calls.push({ path, ...options });
          throw failure;
        },
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, undefined);
  }
});

test("post-write name verification fails closed and a retry preserves partial successful keys", async () => {
  const mock = cloud({ secrets: ["GARMIN_EMAIL", "GARMIN_PASSWORD"] });
  let fail = true;
  const api = (path, options) => {
    if (options?.body?.name === "PROVIDER_ENCRYPTION_KEY" && fail) {
      fail = false;
      throw new CloudflareApiError(path, 403, [10000]);
    }
    return mock.api(path, options);
  };
  const args = { config: readDeployConfig(template), env: {}, api };
  await assert.rejects(prepareWorkerSecrets(args), /403/);
  await prepareWorkerSecrets(args);
  assert.equal(
    mock.calls.filter((call) => call.body?.name === "BETTER_AUTH_SECRET")
      .length,
    1,
  );
  const missing = cloud({ secrets: [] });
  await assert.rejects(
    prepareWorkerSecrets({
      config: readDeployConfig(template),
      env: { GARMIN_EMAIL: "email", GARMIN_PASSWORD: "password" },
      api: (path, options) =>
        options?.method === "PUT" ? {} : missing.api(path, options),
    }),
    /name verification failed/,
  );
});

test("Cloudflare transport sends multipart upload without a JSON content-type", async () => {
  const body = new globalThis.FormData();
  body.set("metadata", "{}");
  const api = cloudflareApi({
    accountId,
    apiToken: "private-token",
    fetch: async (_url, init) => {
      assert.equal(init.body, body);
      assert.equal(init.headers["Content-Type"], undefined);
      return globalThis.Response.json({ success: true, result: {} });
    },
  });
  await api("/workers/scripts/test", { method: "PUT", body });
});

test("deploy entry always provisions keys and Cloudflare template prompts only Garmin secrets", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.ok(
    pkg.scripts.deploy.startsWith(
      "node scripts/prepare-deploy.mjs --provision &&",
    ),
  );
  const example = readFileSync(
    new URL("../.dev.vars.example", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    example
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split("=")[0]),
    ["GARMIN_PERSONAL_API_KEY", "GARMIN_EMAIL", "GARMIN_PASSWORD"],
  );
  for (const name of [
    "BOOTSTRAP_SECRET",
    "BETTER_AUTH_SECRET",
    "PROVIDER_ENCRYPTION_KEY",
    "APP_TIMEZONE",
    "OSM_TILE_URL",
  ])
    assert.equal(name in pkg.cloudflare.bindings, false);
  const config = readDeployConfig(template);
  assert.equal(config.vars.APP_TIMEZONE, undefined);
  assert.equal(config.vars.OSM_TILE_URL, undefined);
  assert.equal(config.vars.PROVIDER_KEY_VERSION, "1");
  for (const name of ["APP_URL", "PROVIDER_KEY_VERSION"]) {
    assert.match(pkg.cloudflare.bindings[name].description, /默认/);
    assert.match(pkg.cloudflare.bindings[name].description, /无需修改|不修改/);
  }
});

test("weekly cron uses Cloudflare Sunday syntax and matches archive repair dispatch", () => {
  const config = readDeployConfig(template);
  assert.ok(config.triggers.crons.includes("30 2 * * SUN"));
  assert.equal(config.triggers.crons.includes("30 2 * * 0"), false);
  const scheduler = readFileSync(
    new URL("../apps/worker/src/services/scheduler.ts", import.meta.url),
    "utf8",
  );
  assert.ok(scheduler.includes('cron === "30 2 * * SUN"'));
});

test("jurisdiction settings are passed to resource creation and checked on reuse", async () => {
  const text = fixture((config) => {
    config.d1_databases[0].jurisdiction = "eu";
    config.r2_buckets[0].jurisdiction = "eu";
  });
  const mock = cloud({ jurisdiction: "eu" });
  await prepareDeploy({ text, env, api: mock.api });
  assert.equal(
    mock.calls.find((call) => call.resource === "/d1/database").body
      .jurisdiction,
    "eu",
  );
  assert.equal(
    mock.calls.find((call) => call.resource === "/r2/buckets").jurisdiction,
    "eu",
  );
  const wrong = cloud({
    database: { uuid: databaseId, name: "cf-garmin-mcp", jurisdiction: "us" },
  });
  await assert.rejects(
    prepareDeploy({ text, env, api: wrong.api }),
    /jurisdiction/,
  );
});
