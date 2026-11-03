// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS model_choice JSONB;
  UPDATE agent_definitions SET model_choice = CASE
    WHEN provider IS NOT NULL AND provider <> '' AND model IS NOT NULL AND model <> ''
      THEN jsonb_build_object('mode', 'pin', 'provider', provider, 'model', model)
    ELSE jsonb_build_object('mode', 'list')
  END WHERE model_choice IS NULL;
`;
export const down = `ALTER TABLE agent_definitions DROP COLUMN IF EXISTS model_choice;`;
