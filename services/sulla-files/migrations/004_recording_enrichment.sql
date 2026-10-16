CREATE TABLE IF NOT EXISTS recording_enrichment_jobs (
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','waiting_runtime','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recording_enrichment_jobs_ready
  ON recording_enrichment_jobs(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS recording_metadata (
  file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  language TEXT,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  chapters JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_seconds DOUBLE PRECISION,
  generator TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
