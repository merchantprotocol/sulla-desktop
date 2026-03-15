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
