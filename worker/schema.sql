-- Phones that have asked to use the school's AI. token_hash is a SHA-256 of a secret only the phone has.
CREATE TABLE IF NOT EXISTS phones (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | removed
  admin INTEGER NOT NULL DEFAULT 0,
  owner INTEGER NOT NULL DEFAULT 0, -- the one master admin: can't be removed, and only they can pass it on
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

-- Practice routes the school uses for road-test days, added by admins from the Routes tab. The id is
-- random and is also the student link (#/t/<id>), so anyone with the link can see that one route.
CREATE TABLE IF NOT EXISTS test_routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON: start, stops, line (encoded polyline), seconds, meters, minutes, level
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
