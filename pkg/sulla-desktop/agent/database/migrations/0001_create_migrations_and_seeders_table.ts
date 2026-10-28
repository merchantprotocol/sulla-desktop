// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// migrations/0001_create_migrations_and_seeders_table.ts

export const up = `
  CREATE TABLE IF NOT EXISTS sulla_migrations (
    id          SERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sulla_seeders (
    id          SERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

export const down = `
  DROP TABLE IF EXISTS sulla_seeders;
  DROP TABLE IF EXISTS sulla_migrations;
`;
