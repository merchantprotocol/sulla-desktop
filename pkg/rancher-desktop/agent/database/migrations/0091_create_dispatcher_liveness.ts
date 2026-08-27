/** Durable dispatcher tick liveness, independent of work/task rows. */
export const up = `
  CREATE TABLE IF NOT EXISTS dispatcher_liveness (
    id                         BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
    last_tick_started_at       TIMESTAMPTZ,
    last_tick_at               TIMESTAMPTZ,
    next_expected_tick_at      TIMESTAMPTZ,
    last_outcome               TEXT NOT NULL DEFAULT 'never',
    checking                   BOOLEAN NOT NULL DEFAULT false,
    consecutive_wedge_count    INTEGER NOT NULL DEFAULT 0,
    wedge_count                INTEGER NOT NULL DEFAULT 0,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO dispatcher_liveness (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
`;

export const down = `DROP TABLE IF EXISTS dispatcher_liveness;`;
