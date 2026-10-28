// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = String.raw`
ALTER TABLE subject_memory.items DROP CONSTRAINT IF EXISTS items_origin_check;
ALTER TABLE subject_memory.items ADD CONSTRAINT items_origin_check
  CHECK(origin IN ('user_stated','model_inferred','observed_outcome','seeded'));
`;

export const down = String.raw`
UPDATE subject_memory.items SET superseded_ts=coalesce(superseded_ts,(extract(epoch from now())*1000)::bigint)
 WHERE origin='seeded' AND superseded_ts IS NULL;
ALTER TABLE subject_memory.items DROP CONSTRAINT IF EXISTS items_origin_check;
ALTER TABLE subject_memory.items ADD CONSTRAINT items_origin_check
  CHECK(origin IN ('user_stated','model_inferred','observed_outcome')) NOT VALID;
`;
