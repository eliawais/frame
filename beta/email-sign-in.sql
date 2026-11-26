CREATE TABLE IF NOT EXISTS email_challenges (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invite TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_challenges_by_expiry ON email_challenges(expires_at);

CREATE TABLE IF NOT EXISTS email_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_rate_limits_by_expiry ON email_rate_limits(expires_at);
