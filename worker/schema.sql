-- Phones that have asked to use the school's AI. token_hash is a SHA-256 of a secret only the phone has.
CREATE TABLE IF NOT EXISTS phones (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | removed
  admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_seen INTEGER,
  day TEXT,
  day_count INTEGER NOT NULL DEFAULT 0,
  push TEXT -- an admin's notification subscription (JSON), if they turned notifications on
);

-- The school's Gemini key, set by an admin from the app. Never sent back out.
CREATE TABLE IF NOT EXISTS settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
