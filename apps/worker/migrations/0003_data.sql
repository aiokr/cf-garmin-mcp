ALTER TABLE provider_connections ADD COLUMN credential_fingerprint TEXT;
ALTER TABLE provider_connections ADD COLUMN last_error_code TEXT;
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id),
  external_activity_id TEXT NOT NULL,
  sport_type TEXT NOT NULL,
  name TEXT NOT NULL,
  start_time_utc TEXT NOT NULL,
  local_date TEXT NOT NULL,
  duration_s REAL, moving_s REAL, distance_m REAL,
  avg_hr REAL, max_hr REAL, avg_speed_mps REAL, avg_cadence REAL,
  avg_power_w REAL, elevation_gain_m REAL, calories_kcal REAL,
  source TEXT NOT NULL DEFAULT 'garmin',
  synced_at TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  UNIQUE(connection_id, external_activity_id)
);
CREATE INDEX activities_connection_time ON activities(connection_id, start_time_utc DESC, id);
CREATE INDEX activities_connection_date ON activities(connection_id, local_date);
CREATE TABLE activity_files (
  id TEXT PRIMARY KEY, activity_id TEXT NOT NULL REFERENCES activities(id),
  format TEXT NOT NULL DEFAULT 'fit', r2_key TEXT, sha256 TEXT, size_bytes INTEGER,
  source TEXT NOT NULL DEFAULT 'garmin', status TEXT NOT NULL CHECK(status IN ('pending','ready','error')),
  error_code TEXT, UNIQUE(activity_id, format)
);
CREATE TABLE daily_health (
  connection_id TEXT NOT NULL REFERENCES provider_connections(id), local_date TEXT NOT NULL,
  steps INTEGER, resting_hr REAL, sleep_seconds REAL, sleep_score REAL, hrv REAL,
  stress REAL, body_battery REAL, distance_m REAL,
  source TEXT NOT NULL DEFAULT 'garmin', fetched_at TEXT NOT NULL,
  availability TEXT NOT NULL, PRIMARY KEY(connection_id, local_date)
);
CREATE TABLE training_metrics (
  connection_id TEXT NOT NULL REFERENCES provider_connections(id), local_date TEXT NOT NULL,
  vo2max REAL, readiness REAL, training_load REAL, training_status TEXT,
  source TEXT NOT NULL DEFAULT 'garmin', fetched_at TEXT NOT NULL,
  availability TEXT NOT NULL, PRIMARY KEY(connection_id, local_date)
);
CREATE TABLE devices (
  connection_id TEXT NOT NULL REFERENCES provider_connections(id), external_device_id TEXT NOT NULL,
  model TEXT, last_seen_at TEXT NOT NULL, PRIMARY KEY(connection_id, external_device_id)
);
CREATE TABLE personal_records (
  connection_id TEXT NOT NULL REFERENCES provider_connections(id), external_id TEXT NOT NULL,
  type TEXT NOT NULL, value REAL, unit TEXT, recorded_at TEXT,
  fetched_at TEXT NOT NULL, PRIMARY KEY(connection_id, external_id)
);
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES provider_connections(id),
  stream TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('incremental','backfill')),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','cancelled')),
  started_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT NOT NULL,
  counts INTEGER NOT NULL DEFAULT 0, error_code TEXT, workflow_id TEXT
);
CREATE UNIQUE INDEX sync_one_active_stream ON sync_runs(connection_id,stream) WHERE status IN ('queued','running');
CREATE TABLE sync_cursors (
  connection_id TEXT NOT NULL REFERENCES provider_connections(id), stream TEXT NOT NULL,
  checkpoint TEXT NOT NULL, last_success_at TEXT NOT NULL, PRIMARY KEY(connection_id,stream)
);
CREATE TABLE owner_settings (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id),
  health_history_days INTEGER NOT NULL DEFAULT 90 CHECK(health_history_days BETWEEN 1 AND 3650),
  activity_history_days INTEGER NOT NULL DEFAULT 365 CHECK(activity_history_days BETWEEN 1 AND 7300),
  auto_sync INTEGER NOT NULL DEFAULT 1 CHECK(auto_sync IN (0,1)),
  archive_fit INTEGER NOT NULL DEFAULT 1 CHECK(archive_fit IN (0,1))
);
CREATE TABLE client_access_log (
  user_id TEXT NOT NULL REFERENCES "user"(id), client_id TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL, PRIMARY KEY(user_id,client_id)
);
CREATE TABLE client_grants (
  user_id TEXT NOT NULL REFERENCES "user"(id), client_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, revoked_at TEXT,
  PRIMARY KEY(user_id,client_id)
);
