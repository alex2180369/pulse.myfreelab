'use strict';
module.exports = `
CREATE TABLE IF NOT EXISTS user_meta (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tz TEXT NOT NULL DEFAULT 'UTC',
  sandbox INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'ember',
  remind_at TEXT,
  created_day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS habits_user ON habits(user_id);
CREATE TABLE IF NOT EXISTS checks (
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  done INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (habit_id, day)
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_sent (
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  PRIMARY KEY (habit_id, day)
);
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
