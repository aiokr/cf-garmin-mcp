export interface Env {
  DB: D1Database;
  FIT_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  INSTANCE_GUARD: DurableObjectNamespace;
  GARMIN_AUTH: DurableObjectNamespace;
  OAUTH_COORDINATOR: DurableObjectNamespace;
  SYNC_WORKFLOW: Workflow<{ runId: string }>;
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  PROVIDER_ENCRYPTION_KEY?: string;
  PROVIDER_ENCRYPTION_KEY_PREVIOUS?: string;
  PROVIDER_KEY_VERSION?: string;
  MAX_FIT_BYTES?: string;
  MCP_ALLOWED_ORIGINS?: string;
  GARMIN_AUTH_MODE: string;
  GARMIN_REGION: string;
  GARMIN_PERSONAL_API_KEY?: string;
  GARMIN_EMAIL?: string;
  GARMIN_PASSWORD?: string;
}
