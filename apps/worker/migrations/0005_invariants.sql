CREATE UNIQUE INDEX provider_one_active_connection ON provider_connections(user_id,provider) WHERE status IN ('pending','connected');
ALTER TABLE sync_runs ADD COLUMN initial_sync INTEGER NOT NULL DEFAULT 0;
