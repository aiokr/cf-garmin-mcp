// Protocol reference: python-garminconnect 0.3.20 (Ron Klinkien, MIT),
// and shyim/garmin-cf-mcp (shyim, MIT). Full notices in third-party/.
// Uses only standard fetch; no TLS impersonation, CAPTCHA bypass or strategy rotation.
import { GARMIN_HOSTS, providerStatus } from "./config";
import { upstream, jsonBody, readBytes } from "./http";
import { ServiceError } from "../../lib/errors";
import type { Env } from "../../env";

export type Region = "CN" | "GLOBAL";
export type Tokens = {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  expiresAt: number;
};
export type MfaPending = { cookies: string; method: string; region: Region };
export type Login =
  { status: "ok"; tokens: Tokens } | { status: "mfa"; pending: MfaPending };
const CLIENT = "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2";
const SSO_CLIENT = "GCM_IOS_DARK";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
export const NATIVE_HEADERS = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-Client-Platform": "Android",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
};
const domain = (region: Region) =>
  region === "CN" ? "garmin.cn" : "garmin.com";
const service = (region: Region) =>
  `https://mobile.integration.${domain(region)}/gcm/ios`;
const params = (region: Region) =>
  new URLSearchParams({
    clientId: SSO_CLIENT,
    locale: "en-US",
    service: service(region),
  });
export const personalBase = (region: Region) =>
  `https://personal.connectapi.${domain(region)}`;

function expiry(token: string, fallback: number): number {
  try {
    const payload = token
      .split(".")[1]!
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const parsed = JSON.parse(
      atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")),
    ) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now() / 1000
      ? parsed.exp * 1000
      : fallback;
  } catch {
    return fallback;
  }
}
function ssoHeaders(region: Region, cookies: string): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: GARMIN_HOSTS[region].sso,
    Referer: `${GARMIN_HOSTS[region].sso}/mobile/sso/en_US/sign-in?${params(region)}`,
    Cookie: cookies,
  };
}
function cookiesFrom(response: Response, old = ""): string {
  const jar = new Map(
    old
      .split(";")
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf("=");
        return [pair.slice(0, i).trim(), pair.slice(i + 1)] as const;
      }),
  );
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]!;
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
type SsoResponse = {
  responseStatus?: { type?: string };
  serviceTicketId?: string;
  customerMfaInfo?: { mfaLastMethodUsed?: string };
};
async function ssoResult(
  response: Response,
  region: Region,
  cookies: string,
): Promise<Login> {
  const data = await jsonBody<SsoResponse>(response);
  if (data.responseStatus?.type === "SUCCESSFUL" && data.serviceTicketId)
    return {
      status: "ok",
      tokens: await diExchange(region, {
        service_ticket: data.serviceTicketId,
        service_url: service(region),
        grant_type:
          "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket",
      }),
    };
  if (data.responseStatus?.type === "MFA_REQUIRED")
    return {
      status: "mfa",
      pending: {
        cookies,
        method: data.customerMfaInfo?.mfaLastMethodUsed || "email",
        region,
      },
    };
  if (data.responseStatus?.type === "INVALID_USERNAME_PASSWORD")
    throw new ServiceError("PROVIDER_CREDENTIALS_REJECTED", 401);
  if (data.responseStatus?.type === "CAPTCHA_REQUIRED")
    throw new ServiceError("PROVIDER_CAPTCHA_REQUIRED", 403);
  throw new ServiceError("PROVIDER_LOGIN_REJECTED", 401);
}
async function diExchange(
  region: Region,
  form: Record<string, string>,
  clientId = CLIENT,
): Promise<Tokens> {
  const response = await upstream(
    `${GARMIN_HOSTS[region].di}/di-oauth2-service/oauth/token`,
    {
      method: "POST",
      headers: {
        ...NATIVE_HEADERS,
        Authorization: `Basic ${btoa(clientId + ":")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: clientId, ...form }).toString(),
    },
    0,
  );
  const data = await jsonBody<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }>(response);
  if (!data.access_token || !(data.refresh_token || form.refresh_token))
    throw new ServiceError("INVALID_UPSTREAM_RESPONSE", 502);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || form.refresh_token,
    clientId,
    expiresAt: expiry(
      data.access_token,
      Date.now() + (data.expires_in || 3600) * 1000,
    ),
  };
}
export async function login(env: Env): Promise<Login> {
  const config = providerStatus(env);
  if (!config.configured || !config.region)
    throw new ServiceError(
      config.code || "INVALID_PROVIDER_CONFIGURATION",
      400,
    );
  if (config.mode === "personal_api") {
    const response = await upstream(
      `${personalBase(config.region)}/personalapitoken-service/personal-api/personal-api-key/token`,
      {
        method: "POST",
        headers: {
          Authorization: `ApiKey ${env.GARMIN_PERSONAL_API_KEY!}`,
          Accept: "*/*",
        },
      },
      0,
    );
    const text = new TextDecoder()
      .decode(await readBytes(response, 65_536))
      .trim();
    let token = text;
    if (text.startsWith("{")) {
      const data = JSON.parse(text) as {
        access_token?: string;
        accessToken?: string;
      };
      token = data.access_token || data.accessToken || "";
    }
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
      throw new ServiceError("INVALID_UPSTREAM_RESPONSE", 502);
    return {
      status: "ok",
      tokens: {
        accessToken: token,
        expiresAt: expiry(token, Date.now() + 23 * 3600_000),
      },
    };
  }
  const page = await upstream(
    `${GARMIN_HOSTS[config.region].sso}/mobile/sso/en_US/sign-in?${params(config.region)}`,
    { headers: { "User-Agent": UA, Accept: "text/html" } },
    0,
  );
  const cookies = cookiesFrom(page);
  await page.body?.cancel();
  const response = await upstream(
    `${GARMIN_HOSTS[config.region].sso}/mobile/api/login?${params(config.region)}`,
    {
      method: "POST",
      headers: ssoHeaders(config.region, cookies),
      body: JSON.stringify({
        username: env.GARMIN_EMAIL,
        password: env.GARMIN_PASSWORD,
        rememberMe: true,
        captchaToken: "",
      }),
    },
    0,
  );
  return ssoResult(response, config.region, cookiesFrom(response, cookies));
}
export async function completeMfa(
  pending: MfaPending,
  code: string,
): Promise<Tokens> {
  const response = await upstream(
    `${GARMIN_HOSTS[pending.region].sso}/mobile/api/mfa/verifyCode?${params(pending.region)}`,
    {
      method: "POST",
      headers: ssoHeaders(pending.region, pending.cookies),
      body: JSON.stringify({
        mfaMethod: pending.method,
        mfaVerificationCode: code,
        rememberMyBrowser: false,
        reconsentList: [],
        mfaSetup: false,
      }),
    },
    0,
  );
  const result = await ssoResult(response, pending.region, pending.cookies);
  if (result.status !== "ok") throw new ServiceError("INVALID_MFA_CODE", 400);
  return result.tokens;
}
export async function refresh(env: Env, tokens: Tokens): Promise<Login> {
  if (env.GARMIN_AUTH_MODE === "personal_api") return login(env);
  if (!tokens.refreshToken || !tokens.clientId)
    throw new ServiceError("PROVIDER_REAUTH_REQUIRED", 401);
  try {
    return {
      status: "ok",
      tokens: await diExchange(
        env.GARMIN_REGION as Region,
        { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
        tokens.clientId,
      ),
    };
  } catch (error) {
    // A single credential retry; no automatic cross-mode fallback or loops.
    if (
      error instanceof ServiceError &&
      ["PROVIDER_UNAUTHORIZED", "UPSTREAM_REJECTED"].includes(error.code)
    )
      return login(env);
    throw error;
  }
}
