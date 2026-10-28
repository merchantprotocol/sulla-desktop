// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS model_slot TEXT;
  DO $$ BEGIN
    ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_model_slot
      CHECK (model_slot IS NULL OR model_slot IN ('primary', 'secondary', 'subconscious'));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  UPDATE agent_definitions SET model_slot = CASE
    WHEN lower(COALESCE(model, '')) ~ '(haiku|mini|flash|nano|lite|luna|fast)' THEN 'subconscious'
    WHEN lower(COALESCE(model, '')) ~ '(sonnet|sol|turbo|medium)' THEN 'secondary'
    ELSE 'primary'
  END WHERE model_slot IS NULL AND model IS NOT NULL
    AND slug NOT IN ('opus-worker', 'sonnet-worker', 'haiku-worker', 'codex-sol-worker', 'codex-luna-worker');
`;

export const down = `ALTER TABLE agent_definitions DROP COLUMN IF EXISTS model_slot;`;
