import { z } from "zod";

export const MCP_SCOPES = [
  "profile:read",
  "activities:read",
  "health:read",
  "sleep:read",
  "training:read",
  "location:read",
  "files:read",
] as const;
export const createPatSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(z.enum(MCP_SCOPES))
      .min(1)
      .max(MCP_SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length),
    expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
  })
  .strict();
export type PersonalAccessToken = {
  id: string;
  name: string;
  hint: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

export const bootstrapSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(12).max(128),
    secret: z.string().min(32).max(256),
  })
  .strict();

export type BootstrapInput = z.infer<typeof bootstrapSchema>;
export type InstanceStatus = {
  initialized: boolean;
  bootstrapAvailable: boolean;
  stage: "development";
};
export type Owner = { id: string; name: string; email: string; role: string };
export type ProviderStatus = {
  mode: "personal_api" | "credentials" | null;
  region: "CN" | "GLOBAL" | null;
  configured: boolean;
  status: "not_connected" | "configuration_error";
  code: string | null;
};
export type Dashboard = {
  date: string;
  timezone: string;
  source: "garmin";
  connectionId: string | null;
  freshness: {
    lastSuccessfulSync: string | null;
    status: "not_synced" | "fresh" | "stale";
  };
  metrics: {
    steps: number | null;
    distanceM: number | null;
    sleepSeconds: number | null;
    restingHr: number | null;
  };
  activities: ActivitySummary[];
  trends: Record<string, unknown>[];
  training: Record<string, unknown> | null;
};
export type ActivitySummary = {
  id: string;
  connection_id: string;
  external_activity_id: string;
  sport_type: string;
  name: string;
  start_time_utc: string;
  local_date: string;
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_speed_mps: number | null;
  avg_cadence: number | null;
  avg_power_w: number | null;
  elevation_gain_m: number | null;
  calories_kcal: number | null;
  synced_at: string;
  source: string;
};
export type ApiResponse<T> = { data: T; requestId: string };
export type ApiErrorBody = {
  error: { code: string; message: string };
  requestId: string;
};
