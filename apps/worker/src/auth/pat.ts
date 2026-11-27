import {
  MCP_SCOPES,
  type PersonalAccessToken,
} from "../../../../packages/shared/src";
import type { Env } from "../env";
import { base64, sha256 } from "../lib/crypto";
import { ServiceError } from "../lib/errors";
import type { McpPrincipal } from "./mcp";

export async function createPat(
  env: Env,
  userId: string,
  input: { name: string; scopes: string[]; expiresInDays: number },
) {
  const token =
    "gmp_pat_" +
    base64(crypto.getRandomValues(new Uint8Array(32)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const item: PersonalAccessToken = {
    id: crypto.randomUUID(),
    name: input.name,
    hint: token.slice(-8),
    scopes: input.scopes,
    createdAt: Date.now(),
    expiresAt: Date.now() + input.expiresInDays * 86_400_000,
    lastUsedAt: null,
    revokedAt: null,
  };
  await env.DB.prepare(
    `INSERT INTO mcp_personal_access_tokens
    (id,user_id,name,token_hash,hint,scopes,resource,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      item.id,
      userId,
      item.name,
      await sha256(token),
      item.hint,
      JSON.stringify(item.scopes),
      new URL(env.APP_URL).origin + "/mcp",
      item.createdAt,
      item.expiresAt,
    )
    .run();
  // Only this creation response contains the plaintext key.
  return { ...item, token };
}

export async function verifyPat(
  env: Env,
  token: string,
): Promise<McpPrincipal> {
  if (!/^gmp_pat_[A-Za-z0-9_-]{43}$/.test(token))
    throw new ServiceError("INVALID_TOKEN", 401);
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT p.id,p.user_id,p.scopes,p.resource
    FROM mcp_personal_access_tokens p
    JOIN instance_state i ON i.owner_user_id=p.user_id AND i.id=1
    JOIN "user" u ON u.id=p.user_id AND u.role='owner'
    WHERE p.token_hash=? AND p.revoked_at IS NULL AND p.expires_at>?`,
  )
    .bind(tokenHash, Date.now())
    .first<{
      id: string;
      user_id: string;
      scopes: string;
      resource: string;
    }>();
  if (!row || row.resource !== new URL(env.APP_URL).origin + "/mcp")
    throw new ServiceError("INVALID_TOKEN", 401);
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes);
  } catch {
    scopes = null;
  }
  if (
    !Array.isArray(scopes) ||
    !scopes.length ||
    scopes.some((scope) => !(MCP_SCOPES as readonly unknown[]).includes(scope))
  )
    throw new ServiceError("INVALID_TOKEN", 401);
  await env.DB.prepare(
    `UPDATE mcp_personal_access_tokens SET last_used_at=?
    WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)`,
  )
    .bind(Date.now(), row.id, Date.now() - 60_000)
    .run();
  return { userId: row.user_id, clientId: "pat:" + row.id, scopes, tokenHash };
}
