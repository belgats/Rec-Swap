CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_index INTEGER NOT NULL CHECK (user_index BETWEEN 0 AND 3),
  source_product_id INTEGER NOT NULL,
  candidate_product_id INTEGER NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at);
CREATE INDEX IF NOT EXISTS feedback_position_idx ON feedback(position);
