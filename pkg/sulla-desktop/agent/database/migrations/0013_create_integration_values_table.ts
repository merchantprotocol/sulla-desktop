// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  CREATE TABLE IF NOT EXISTS integration_values (
    value_id      SERIAL PRIMARY KEY,
    integration_id VARCHAR(100) NOT NULL,
    account_id    VARCHAR(200) NOT NULL DEFAULT 'default',
    property      VARCHAR(100) NOT NULL,
    value         TEXT NOT NULL,
    is_default    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(integration_id, account_id, property)
  );

  ALTER TABLE integration_values ADD COLUMN IF NOT EXISTS account_id VARCHAR(200) NOT NULL DEFAULT 'default';
  ALTER TABLE integration_values ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE INDEX IF NOT EXISTS idx_integration_values_integration_id ON integration_values(integration_id);
  CREATE INDEX IF NOT EXISTS idx_integration_values_property ON integration_values(property);
  CREATE INDEX IF NOT EXISTS idx_integration_values_account ON integration_values(integration_id, account_id);
  CREATE INDEX IF NOT EXISTS idx_integration_values_default ON integration_values(integration_id, is_default);
`;

export const down = `DROP TABLE IF EXISTS integration_values CASCADE;`;
