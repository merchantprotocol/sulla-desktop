import pg from 'pg';

import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS service_agent_definitions (
    id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
    system_prompt text NOT NULL DEFAULT '', soul_content text NOT NULL DEFAULT '', allowed_tools text[] NOT NULL DEFAULT '{}',
    skill_refs text[] NOT NULL DEFAULT '{}', routine_refs text[] NOT NULL DEFAULT '{}', model_priority jsonb NOT NULL DEFAULT '[]'::jsonb,
    version text, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','production','archive')),
    enabled boolean NOT NULL DEFAULT true, config jsonb NOT NULL DEFAULT '{}'::jsonb, prompt_content text NOT NULL DEFAULT '',
    goals_content text NOT NULL DEFAULT '', prompt_files jsonb NOT NULL DEFAULT '{}'::jsonb, provider text, model text, source_kind text NOT NULL DEFAULT 'local',
    when_to_call text NOT NULL DEFAULT '', when_not_to_call text NOT NULL DEFAULT '', send text NOT NULL DEFAULT '', returns text NOT NULL DEFAULT '',
    cost_tier text, can_call text[] NOT NULL DEFAULT '{}', front_door boolean, is_builtin boolean NOT NULL DEFAULT false,
    run_location text NOT NULL DEFAULT 'container' CHECK (run_location IN ('vm','container')),
    owner_issuer text NOT NULL, owner_subject text NOT NULL, authority_id uuid NOT NULL, organization_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(authority_id,organization_id,slug)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS server_agent_runs (
    id text PRIMARY KEY,
    agent_id text NOT NULL,
    label text NOT NULL,
    prompt text NOT NULL,
    provider text NOT NULL,
    model text,
    status text NOT NULL CHECK (status IN ('starting','running','completed','failed','stopped')),
    container_id text,
    output text NOT NULL DEFAULT '',
    error text,
    requested_by text NOT NULL, owner_issuer text, owner_subject text, authority_id uuid, organization_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE service_agent_definitions ADD COLUMN IF NOT EXISTS prompt_files jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query('ALTER TABLE server_agent_runs ADD COLUMN IF NOT EXISTS owner_issuer text');
  await pool.query('ALTER TABLE server_agent_runs ADD COLUMN IF NOT EXISTS owner_subject text');
  await pool.query('ALTER TABLE server_agent_runs ADD COLUMN IF NOT EXISTS authority_id uuid');
  await pool.query('ALTER TABLE server_agent_runs ADD COLUMN IF NOT EXISTS organization_id uuid');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_server_agent_runs_recent ON server_agent_runs(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_server_agent_runs_tenant ON server_agent_runs(authority_id,organization_id,created_at DESC)');
}
