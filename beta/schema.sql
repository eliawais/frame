CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'revoked')),
  created_at INTEGER NOT NULL,
  approval_id TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS sign_in_attempts (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  invite TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sign_in_attempts_by_expiry ON sign_in_attempts(expires_at);

CREATE TABLE IF NOT EXISTS rooms (
  invite_code TEXT PRIMARY KEY,
  signaling_code TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_by_expiry ON rooms(expires_at);

CREATE TABLE IF NOT EXISTS approval_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  first_attempt_at INTEGER,
  sent_at INTEGER,
  provider_id TEXT
);
