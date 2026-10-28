CREATE TABLE IF NOT EXISTS accounts_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  UNIQUE (user_id, issuer),
  CHECK (length(issuer) BETWEEN 1 AND 2048),
  CHECK (length(subject) BETWEEN 1 AND 2048)
);
