import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export class InstanceGuard extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const { key, limit, windowSeconds } = await request.json<{
      key: string;
      limit: number;
      windowSeconds: number;
    }>();
    const now = Date.now();
    const allowed = await this.ctx.storage.transaction(async (storage) => {
      const record = await storage.get<{ count: number; resetAt: number }>(key);
      const current =
        record && record.resetAt > now
          ? record
          : { count: 0, resetAt: now + windowSeconds * 1000 };
      if (current.count >= limit) return false;
      await storage.put(key, { ...current, count: current.count + 1 });
      await storage.setAlarm(now + windowSeconds * 1000);
      return true;
    });
    return Response.json({ allowed });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const records = await this.ctx.storage.list<{ resetAt: number }>();
    for (const [key, record] of records)
      if (record.resetAt <= now) await this.ctx.storage.delete(key);
    if ((await this.ctx.storage.list()).size)
      await this.ctx.storage.setAlarm(now + 60_000);
  }
}
