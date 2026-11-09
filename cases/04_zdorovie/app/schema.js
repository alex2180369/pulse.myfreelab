'use strict';
module.exports = `
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sex TEXT,
  birth_year INTEGER,
  height_cm REAL,
  title TEXT NOT NULL DEFAULT '',
  diary_remind_at TEXT,
  consent_at TEXT
);
CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  v1 REAL NOT NULL,
  v2 REAL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, metric, day)
);
CREATE TABLE IF NOT EXISTS goals (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  target REAL NOT NULL,
  start REAL,
  direction TEXT NOT NULL,
  due_day TEXT,
  created_at TEXT NOT NULL,
  reached_at TEXT,
  PRIMARY KEY (user_id, metric)
);
CREATE TABLE IF NOT EXISTS labs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS labs_user ON labs(user_id, day);
CREATE TABLE IF NOT EXISTS lab_values (
  lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (lab_id, code)
);
CREATE TABLE IF NOT EXISTS lab_files (
  id INTEGER PRIMARY KEY,
  lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  seeded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dose TEXT NOT NULL DEFAULT '',
  times TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS med_intakes (
  med_id INTEGER NOT NULL REFERENCES meds(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  time TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  PRIMARY KEY (med_id, day, time)
);
CREATE TABLE IF NOT EXISTS access (
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  specialist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (client_id, specialist_id)
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  specialist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  message TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_specialist ON requests(specialist_id, status);
CREATE INDEX IF NOT EXISTS requests_client ON requests(client_id, id);
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY,
  trainer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  time TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  kind TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_day ON slots(day, time);
CREATE TABLE IF NOT EXISTS bookings (
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slot_id, client_id)
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  section TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  video_url TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS materials_kind ON materials(kind, published, position);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
CREATE TABLE IF NOT EXISTS sent (
  key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sent_user ON sent(user_id, day);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
