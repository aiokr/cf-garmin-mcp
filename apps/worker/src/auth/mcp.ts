import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { ServiceError } from "../lib/errors";
import { MCP_SCOPES } from "../../../../packages/shared/src";
import { verifyPat } from "./pat";

export const SCOPES = MCP_SCOPES;
export const stringArray = (value: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
};
export type McpPrincipal = {
  userId: string;
  clientId: string;
  scopes: string[];
  tokenHash: string;
};

export async function verifyMcpToken(
  env: Env,
  request: Request,
): Promise<McpPrincipal> {
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer [\x21-\x7e]{20,2048}$/.test(authorization))
    throw new ServiceError("INVALID_TOKEN", 401);
  const token = authorization.slice(7);
  if (token.startsWith("gmp_pat_")) return verifyPat(env, token);
  // The one authorization server emits opaque tokens and stores this hash.
  // Every request reads authoritative state: expiry, session, owner, client,
  // consent, scope and resource, so revocation has no JWT/cache delay.
  const tokenHash = await sha256(authorization.slice(7));
  const row = await env.DB.prepare(
    `SELECT t.userId,t.clientId,t.scopes,t.resources,t.expiresAt,t.revoked,t.confirmation,
    c.disabled,s.expiresAt AS sessionExpires,co.scopes AS consentScopes,co.resources AS consentResources
    FROM oauthAccessToken t JOIN oauthClient c ON c.clientId=t.clientId
    JOIN session s ON s.id=t.sessionId JOIN instance_state i ON i.owner_user_id=t.userId
    JOIN oauthConsent co ON co.userId=t.userId AND co.clientId=t.clientId
    WHERE t.token=? AND i.id=1 LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{
      userId: string;
      clientId: string;
      scopes: string;
      resources: string | null;
      expiresAt: number;
      revoked: number | null;
      disabled: number | null;
      sessionExpires: number;
      consentScopes: string;
      consentResources: string;
      confirmation: string | null;
    }>();
  if (
    !row ||
    row.disabled ||
    row.revoked ||
    Number(row.expiresAt) <= Date.now() ||
    Number(row.sessionExpires) <= Date.now() ||
    row.confirmation
  )
    throw new ServiceError("INVALID_TOKEN", 401);
  const resource = new URL(env.APP_URL).origin + "/mcp";
  if (
    !stringArray(row.resources).includes(resource) ||
    !stringArray(row.consentResources).includes(resource)
  )
    throw new ServiceError("INVALID_TOKEN_AUDIENCE", 401);
  const scopes = stringArray(row.scopes);
  const consent = stringArray(row.consentScopes);
  if (scopes.some((scope) => !consent.includes(scope)))
    throw new ServiceError("INVALID_TOKEN", 401);
  return { userId: row.userId, clientId: row.clientId, scopes, tokenHash };
}
export function requireScopes(principal: McpPrincipal, required: string[]) {
  if (required.some((scope) => !principal.scopes.includes(scope)))
    throw new ServiceError("INSUFFICIENT_SCOPE", 403);
}
