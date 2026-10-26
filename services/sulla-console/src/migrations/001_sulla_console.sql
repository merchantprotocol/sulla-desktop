-- Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
-- Licensed under the Sulla Fair-Code License. See LICENSE.

CREATE SCHEMA IF NOT EXISTS sulla_console;
CREATE TABLE IF NOT EXISTS sulla_console.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
