import { DurableObject } from "cloudflare:workers";
import { createAuth } from "../auth/config";
import type { Env } from "../env";

// All code issuance, refresh, consent changes and owner revocation share one
// queue. A refresh that started before revoke cannot commit a token after it.
export class OAuthCoordinator extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();
  async fetch(request: Request): Promise<Response> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (new URL(request.url).pathname === "/internal/revoke") {
        const { userId, clientId } = await request.json<{
          userId: string;
          clientId: string;
        }>();
        await this.env.DB.batch([
          this.env.DB.prepare(
            "DELETE FROM oauthAccessToken WHERE userId=? AND clientId=?",
          ).bind(userId, clientId),
          this.env.DB.prepare(
            "DELETE FROM oauthRefreshToken WHERE userId=? AND clientId=?",
          ).bind(userId, clientId),
          this.env.DB.prepare(
            "DELETE FROM oauthConsent WHERE userId=? AND clientId=?",
          ).bind(userId, clientId),
          this.env.DB.prepare(
            "DELETE FROM verification WHERE json_valid(value) AND json_extract(value,'$.type')='authorization_code' AND json_extract(value,'$.userId')=? AND json_extract(value,'$.query.client_id')=?",
          ).bind(userId, clientId),
          this.env.DB.prepare(
            "INSERT INTO client_grants(user_id,client_id,revoked_at) VALUES (?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET revoked_at=excluded.revoked_at,version=version+1",
          ).bind(userId, clientId, new Date().toISOString()),
        ]);
        return Response.json({ revoked: true });
      }
      return createAuth(this.env).handler(request);
    } finally {
      release();
    }
  }
}
