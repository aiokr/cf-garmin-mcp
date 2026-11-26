import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  login,
  refresh,
  completeMfa,
  type Tokens,
  type MfaPending,
  type Login,
} from "../providers/garmin/auth";
import {
  identity,
  providerRequest,
  type ProviderOperation,
  type ProviderQuery,
} from "../providers/garmin/client";
import {
  seal,
  open,
  credentialFingerprint,
  type EncryptionContext,
} from "../lib/crypto";
import { ServiceError, safeCode } from "../lib/errors";

export type Connection = {
  id: string;
  user_id: string;
  region: string;
  auth_type: string;
  external_user_id: string;
  display_name: string | null;
  encrypted_tokens: string | null;
  credential_fingerprint: string | null;
  status: string;
  last_verified_at: string | null;
  last_synced_at: string | null;
  last_error_code: string | null;
};
type Pending = {
  id: string;
  sessionId: string;
  expiresAt: number;
  attempts: number;
  encrypted: string;
};
type Command = {
  userId: string;
  connectionId: string;
  action: "verify" | "read" | "mfa" | "revoke" | "rotate";
  sessionId?: string;
  challengeId?: string;
  code?: string;
  operation?: ProviderOperation;
  query?: ProviderQuery;
};

export class GarminAuth extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const command = await request.json<Command>();
    // Explicit queue serializes all awaits, including refresh/revoke/rotation.
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.execute(command);
    } catch (error) {
      const code = safeCode(error);
      const status = error instanceof ServiceError ? error.status : 500;
      if (
        [
          "PROVIDER_UNAUTHORIZED",
          "PROVIDER_CREDENTIALS_REJECTED",
          "PROVIDER_REAUTH_REQUIRED",
          "PROVIDER_ACCOUNT_CHANGED",
          "PROVIDER_CONFIGURATION_CHANGED",
        ].includes(code)
      ) {
        await this.env.DB.prepare(
          "UPDATE provider_connections SET status=?, last_error_code=? WHERE id=? AND user_id=? AND status<>?",
        )
          .bind(
            "needs_reauth",
            code,
            command.connectionId,
            command.userId,
            "revoked",
          )
          .run();
      }
      return Response.json(
        {
          error: code,
          retryAfter: error instanceof ServiceError ? error.retryAfter : 0,
        },
        { status },
      );
    } finally {
      release();
    }
  }

  private async execute(command: Command): Promise<Response> {
    const row = await this.env.DB.prepare(
      "SELECT * FROM provider_connections WHERE id=? AND user_id=?",
    )
      .bind(command.connectionId, command.userId)
      .first<Connection>();
    if (!row) throw new ServiceError("CONNECTION_NOT_FOUND", 404);
    const context: EncryptionContext = {
      userId: row.user_id,
      connectionId: row.id,
      region: row.region,
    };
    if (command.action === "revoke") {
      await this.env.DB.prepare(
        "UPDATE provider_connections SET status=?, encrypted_tokens=NULL, key_version=NULL, last_error_code=NULL WHERE id=? AND user_id=?",
      )
        .bind("revoked", row.id, row.user_id)
        .run();
      await this.ctx.storage.deleteAll();
      return Response.json({ disconnected: true });
    }
    if (row.status === "revoked")
      throw new ServiceError("CONNECTION_REVOKED", 409);
    if (
      row.region !== this.env.GARMIN_REGION ||
      row.auth_type !== this.env.GARMIN_AUTH_MODE
    )
      throw new ServiceError("PROVIDER_CONFIGURATION_CHANGED", 409);
    if (command.action === "verify") {
      if (!command.sessionId) throw new ServiceError("AUTH_REQUIRED", 401);
      return this.finishLogin(
        row,
        context,
        await login(this.env),
        command.sessionId,
      );
    }
    if (command.action === "mfa") {
      const pending = await this.ctx.storage.get<Pending>("pending");
      if (
        !pending ||
        pending.id !== command.challengeId ||
        pending.sessionId !== command.sessionId ||
        pending.expiresAt < Date.now() ||
        pending.attempts >= 5
      ) {
        if (pending?.expiresAt && pending.expiresAt < Date.now())
          await this.ctx.storage.delete("pending");
        throw new ServiceError("MFA_CHALLENGE_INVALID", 400);
      }
      if (!command.code || !/^[\da-zA-Z-]{4,12}$/.test(command.code))
        throw new ServiceError("INVALID_MFA_CODE", 400);
      await this.ctx.storage.put("pending", {
        ...pending,
        attempts: pending.attempts + 1,
      });
      const challenge = await open<MfaPending & { fingerprint: string }>(
        this.env,
        { ...context, purpose: "mfa" },
        pending.encrypted,
      );
      if (challenge.fingerprint !== (await credentialFingerprint(this.env))) {
        await this.ctx.storage.delete("pending");
        throw new ServiceError("PROVIDER_CONFIGURATION_CHANGED", 409);
      }
      const tokens = await completeMfa(challenge, command.code);
      const response = await this.finishLogin(
        row,
        context,
        { status: "ok", tokens },
        command.sessionId!,
      );
      await this.ctx.storage.delete("pending");
      return response;
    }
    if (!row.encrypted_tokens || row.status !== "connected")
      throw new ServiceError("PROVIDER_REAUTH_REQUIRED", 401);
    if (row.credential_fingerprint !== (await credentialFingerprint(this.env)))
      throw new ServiceError("PROVIDER_CONFIGURATION_CHANGED", 409);
    let tokens = await open<Tokens>(this.env, context, row.encrypted_tokens);
    if (command.action === "rotate") {
      await this.saveTokens(row, context, tokens);
      return Response.json({ rotated: true });
    }
    if (tokens.expiresAt < Date.now() + 60_000)
      tokens = await this.renew(row, context, tokens);
    const query = { ...command.query, displayName: row.display_name || "" };
    let value: unknown;
    try {
      value = await providerRequest(
        this.env,
        tokens,
        command.operation!,
        query,
      );
    } catch (error) {
      if (
        !(error instanceof ServiceError) ||
        error.code !== "PROVIDER_UNAUTHORIZED"
      )
        throw error;
      tokens = await this.renew(row, context, tokens);
      value = await providerRequest(
        this.env,
        tokens,
        command.operation!,
        query,
      );
    }
    return value instanceof Uint8Array
      ? new Response(value, {
          headers: { "Content-Type": "application/octet-stream" },
        })
      : Response.json(value);
  }

  private async renew(
    row: Connection,
    context: EncryptionContext,
    tokens: Tokens,
  ): Promise<Tokens> {
    const result = await refresh(this.env, tokens);
    // Background jobs never create a challenge attached to an absent session.
    if (result.status !== "ok")
      throw new ServiceError("PROVIDER_REAUTH_REQUIRED", 401);
    const profile = await identity(this.env, result.tokens);
    if (profile.id !== row.external_user_id)
      throw new ServiceError("PROVIDER_ACCOUNT_CHANGED", 409);
    await this.saveTokens(row, context, result.tokens);
    return result.tokens;
  }
  private async finishLogin(
    row: Connection,
    context: EncryptionContext,
    result: Login,
    sessionId: string,
  ): Promise<Response> {
    if (result.status === "mfa") {
      const pending: Pending = {
        id: crypto.randomUUID(),
        sessionId,
        expiresAt: Date.now() + 10 * 60_000,
        attempts: 0,
        encrypted: await seal(
          this.env,
          { ...context, purpose: "mfa" },
          {
            ...result.pending,
            fingerprint: await credentialFingerprint(this.env),
          },
        ),
      };
      await this.ctx.storage.put("pending", pending);
      await this.ctx.storage.setAlarm(pending.expiresAt);
      await this.env.DB.prepare(
        "UPDATE provider_connections SET status=? WHERE id=?",
      )
        .bind("pending", row.id)
        .run();
      return Response.json({
        status: "mfa",
        challengeId: pending.id,
        expiresAt: pending.expiresAt,
        method: result.pending.method,
      });
    }
    const profile = await identity(this.env, result.tokens);
    if (
      !row.external_user_id.startsWith("pending:") &&
      profile.id !== row.external_user_id
    )
      throw new ServiceError("PROVIDER_ACCOUNT_CHANGED", 409);
    await this.saveTokens(row, context, result.tokens, profile);
    await this.ctx.storage.delete("pending");
    return Response.json({
      status: "connected",
      id: row.id,
      displayName: profile.displayName,
    });
  }
  private async saveTokens(
    row: Connection,
    context: EncryptionContext,
    tokens: Tokens,
    profile?: { id: string; displayName: string },
  ): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE provider_connections SET encrypted_tokens=?, key_version=?, credential_fingerprint=?, status=?, external_user_id=?, display_name=?, last_verified_at=?, last_error_code=NULL WHERE id=? AND user_id=? AND status<>?",
    )
      .bind(
        await seal(this.env, context, tokens),
        Number(this.env.PROVIDER_KEY_VERSION || 1),
        await credentialFingerprint(this.env),
        "connected",
        profile?.id || row.external_user_id,
        profile?.displayName || row.display_name,
        new Date().toISOString(),
        row.id,
        row.user_id,
        "revoked",
      )
      .run();
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.delete("pending");
  }
}

export async function garminCommand(
  env: Env,
  command: Command,
): Promise<Response> {
  const stub = env.GARMIN_AUTH.get(
    env.GARMIN_AUTH.idFromName(command.connectionId),
  );
  const response = await stub.fetch("https://garmin-auth.internal", {
    method: "POST",
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const body = await response.json<{ error: string; retryAfter?: number }>();
    throw new ServiceError(body.error, response.status, body.retryAfter);
  }
  return response;
}
export async function readProvider<T = unknown>(
  env: Env,
  row: Pick<Connection, "user_id" | "id">,
  operation: ProviderOperation,
  query?: ProviderQuery,
): Promise<T> {
  const response = await garminCommand(env, {
    userId: row.user_id,
    connectionId: row.id,
    action: "read",
    operation,
    query,
  });
  return (
    operation === "file"
      ? new Uint8Array(await response.arrayBuffer())
      : await response.json()
  ) as T;
}
