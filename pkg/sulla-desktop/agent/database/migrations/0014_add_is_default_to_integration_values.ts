// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  ALTER TABLE integration_values
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE INDEX IF NOT EXISTS idx_integration_values_default
    ON integration_values(integration_id, is_default);

  -- Backfill from legacy active_account system property when present.
  -- The old format stored active_account on account_id='default' row.
  WITH active_targets AS (
    SELECT integration_id, value AS active_account_id
    FROM integration_values
    WHERE property = 'active_account'
      AND account_id = 'default'
  )
  UPDATE integration_values iv
  SET is_default = TRUE,
      updated_at = CURRENT_TIMESTAMP
  FROM active_targets at
  WHERE iv.integration_id = at.integration_id
    AND iv.account_id = at.active_account_id;

  -- For integrations that still have no default, mark account_id='default' when available.
  UPDATE integration_values iv
  SET is_default = TRUE,
      updated_at = CURRENT_TIMESTAMP
  WHERE iv.account_id = 'default'
    AND NOT EXISTS (
      SELECT 1
      FROM integration_values x
      WHERE x.integration_id = iv.integration_id
        AND x.is_default = TRUE
    );

  -- Final fallback: if no default exists for an integration, mark the lexicographically
  -- first account_id for that integration as default.
  WITH first_accounts AS (
    SELECT integration_id, MIN(account_id) AS account_id
    FROM integration_values
    GROUP BY integration_id
  )
  UPDATE integration_values iv
  SET is_default = TRUE,
      updated_at = CURRENT_TIMESTAMP
  FROM first_accounts fa
  WHERE iv.integration_id = fa.integration_id
    AND iv.account_id = fa.account_id
    AND NOT EXISTS (
      SELECT 1
      FROM integration_values x
      WHERE x.integration_id = iv.integration_id
        AND x.is_default = TRUE
    );
`;

export const down = `
  DROP INDEX IF EXISTS idx_integration_values_default;
  ALTER TABLE integration_values DROP COLUMN IF EXISTS is_default;
`;
