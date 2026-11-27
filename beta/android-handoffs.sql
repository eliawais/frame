CREATE TABLE IF NOT EXISTS android_handoffs (
  code_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS android_handoffs_by_expiry ON android_handoffs(expires_at);
CREATE INDEX IF NOT EXISTS android_handoffs_by_session ON android_handoffs(session_hash);
