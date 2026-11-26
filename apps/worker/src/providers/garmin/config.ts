import type { ProviderStatus } from "../../../../../packages/shared/src";
import type { Env } from "../../env";

// Fixed hosts only. Never accept a client-supplied Garmin upstream URL.
export const GARMIN_HOSTS = {
  CN: {
    sso: "https://sso.garmin.cn",
    di: "https://diauth.garmin.cn",
    connect: "https://connectapi.garmin.cn",
  },
  GLOBAL: {
    sso: "https://sso.garmin.com",
    di: "https://diauth.garmin.com",
    connect: "https://connectapi.garmin.com",
  },
} as const;

export function providerStatus(env: Env): ProviderStatus {
  const mode =
    env.GARMIN_AUTH_MODE === "personal_api" ||
    env.GARMIN_AUTH_MODE === "credentials"
      ? env.GARMIN_AUTH_MODE
      : null;
  const region =
    env.GARMIN_REGION === "CN" || env.GARMIN_REGION === "GLOBAL"
      ? env.GARMIN_REGION
      : null;
  let code: string | null = null;
  if (!mode || !region) code = "INVALID_PROVIDER_CONFIGURATION";
  else if (mode === "personal_api") {
    if (env.GARMIN_EMAIL || env.GARMIN_PASSWORD)
      code = "CONFLICTING_PROVIDER_CREDENTIALS";
    else if (!env.GARMIN_PERSONAL_API_KEY)
      code = "MISSING_PROVIDER_CREDENTIALS";
  } else {
    if (env.GARMIN_PERSONAL_API_KEY) code = "CONFLICTING_PROVIDER_CREDENTIALS";
    else if (!env.GARMIN_EMAIL || !env.GARMIN_PASSWORD)
      code = "MISSING_PROVIDER_CREDENTIALS";
  }
  return {
    mode,
    region,
    configured: !code,
    status: code ? "configuration_error" : "not_connected",
    code,
  };
}
