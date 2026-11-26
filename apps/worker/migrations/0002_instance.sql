CREATE TABLE instance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_user_id TEXT UNIQUE REFERENCES "user"(id) ON DELETE RESTRICT,
  initialized_at INTEGER
);
INSERT INTO instance_state (id) VALUES (1);

-- Defense in depth: no second user, even if a future route accidentally enables signup.
CREATE TRIGGER enforce_single_owner BEFORE INSERT ON "user"
WHEN EXISTS (SELECT 1 FROM "user")
  OR EXISTS (SELECT 1 FROM instance_state WHERE owner_user_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'single_owner_instance');
END;

CREATE TRIGGER preserve_bootstrap_completion BEFORE UPDATE ON instance_state
WHEN OLD.owner_user_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bootstrap_permanently_closed');
END;

CREATE TRIGGER preserve_instance_state BEFORE DELETE ON instance_state
BEGIN
  SELECT RAISE(ABORT, 'instance_state_required');
END;

CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'garmin' CHECK (provider = 'garmin'),
  region TEXT NOT NULL CHECK (region IN ('CN', 'GLOBAL')),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('personal_api', 'credentials')),
  credential_source TEXT NOT NULL DEFAULT 'env' CHECK (credential_source = 'env'),
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  encrypted_tokens TEXT,
  key_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'needs_reauth', 'revoked', 'error')),
  last_verified_at TEXT,
  last_synced_at TEXT
);
CREATE INDEX provider_connections_owner ON provider_connections(user_id, status);
