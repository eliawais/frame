CREATE TABLE IF NOT EXISTS room_members (
  peer_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(signaling_code) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  is_host INTEGER NOT NULL CHECK (is_host IN (0, 1)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS room_members_by_room ON room_members(room_id, expires_at);
CREATE INDEX IF NOT EXISTS room_members_by_expiry ON room_members(expires_at);
CREATE INDEX IF NOT EXISTS room_members_by_session ON room_members(session_hash);
CREATE UNIQUE INDEX IF NOT EXISTS room_members_one_host ON room_members(room_id) WHERE is_host = 1;
