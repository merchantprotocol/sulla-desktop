// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  ALTER TABLE sulla_settings ADD COLUMN IF NOT EXISTS "cast" TEXT;
`;

export const down = `
  ALTER TABLE sulla_settings DROP COLUMN IF EXISTS "cast";
`;
