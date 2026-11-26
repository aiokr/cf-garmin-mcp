import { betterAuth } from "better-auth";
import { oauthProvider } from "@better-auth/oauth-provider";
import { sha256 } from "../lib/crypto.ts";
import type { Env } from "../env";

export function authOptions(env: Env) {
  const baseURL = new URL(env.APP_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(baseURL.hostname);
  if (
    (!local && baseURL.protocol !== "https:") ||
    baseURL.pathname !== "/" ||
    baseURL.username ||
    baseURL.password
  ) {
    throw new Error("Invalid application origin");
  }
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Missing authentication secret");
  return {
    appName: "cf-garmin-mcp",
    baseURL: baseURL.origin,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [baseURL.origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: {
      additionalFields: {
        role: { type: "string" as const, defaultValue: "owner", input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: !local,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: !local,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database" as const,
      window: 60,
      max: 60,
    },
    logger: { disabled: true },
    plugins: [
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        disableJwtPlugin: true,
        scopes: [
          "profile:read",
          "activities:read",
          "health:read",
          "sleep:read",
          "training:read",
          "location:read",
          "files:read",
          "offline_access",
        ],
        grantTypes: ["authorization_code", "refresh_token"],
        resources: [baseURL.origin + "/mcp"],
        clientRegistrationDefaultResources: [baseURL.origin + "/mcp"],
        clientRegistrationDefaultScopes: ["profile:read"],
        clientRegistrationAllowedScopes: [
          "activities:read",
          "health:read",
          "sleep:read",
          "training:read",
          "location:read",
          "files:read",
          "offline_access",
        ],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        clientRegistrationDefaultApplicationType: "infer",
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 30 * 86400,
        codeExpiresIn: 300,
        storeTokens: { hash: (token) => sha256(token) },
      }),
    ],
  };
}

export function createAuth(env: Env) {
  return betterAuth(authOptions(env));
}
