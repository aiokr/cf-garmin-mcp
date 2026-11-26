import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse, printParseErrorCode } from "jsonc-parser";

export function options() {
  const args = process.argv.slice(2);
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (["--local", "--remote"].includes(argument)) {
      if (result.target) throw new Error("Specify exactly one target");
      result.target = argument;
    } else if (["--output", "--from", "--persist-to"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error("Missing option value");
      result[argument.slice(2)] = value;
    } else throw new Error("Unknown option");
  }
  if (!result.target) throw new Error("Specify --local or --remote explicitly");
  if (result.target === "--remote" && result["persist-to"])
    throw new Error("--persist-to is local only");
  return result;
}
export function configuration() {
  const errors = [];
  const config = parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length)
    throw new Error(
      `Invalid Wrangler JSONC: ${printParseErrorCode(errors[0].error)}`,
    );
  const bucket = config.r2_buckets.find(
    (item) => item.binding === "FIT_BUCKET",
  )?.bucket_name;
  if (!bucket) throw new Error("FIT_BUCKET is not configured");
  return { bucket };
}
export function wrangler(args, target) {
  if (args[0] === "d1" && args[1] === "export" && target["persist-to"])
    throw new Error(
      "Wrangler d1 export uses the standard local state; --persist-to is not supported for backup.",
    );
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      ...args,
      target.target,
      ...(target["persist-to"] ? ["--persist-to", target["persist-to"]] : []),
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Wrangler ${args.slice(0, 3).join(" ")} failed; no sensitive output was logged.`,
    );
  return result.stdout;
}
