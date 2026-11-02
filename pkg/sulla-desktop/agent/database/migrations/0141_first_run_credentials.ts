// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  CREATE TABLE IF NOT EXISTS first_run_credentials (
    integration_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    encrypted_payload JSONB NOT NULL,
    key_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (integration_id, account_id)
  );
`;

export const down = `DROP TABLE IF EXISTS first_run_credentials;`;
