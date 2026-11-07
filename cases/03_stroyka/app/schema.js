'use strict';
module.exports = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  foreman_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_site ON tasks(site_id, status);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id, status);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  done_text TEXT NOT NULL,
  workers INTEGER NOT NULL,
  problems TEXT NOT NULL DEFAULT '[]',
  problem_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, day)
);
CREATE TABLE IF NOT EXISTS qc_items (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  state TEXT,
  note TEXT NOT NULL DEFAULT '',
  checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at TEXT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS qc_site ON qc_items(site_id, kind, position);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  seeded INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  qc_item_id INTEGER REFERENCES qc_items(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_site ON photos(site_id, id);
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
`;
