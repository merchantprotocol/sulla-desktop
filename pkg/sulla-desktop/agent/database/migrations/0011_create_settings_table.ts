// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  CREATE TABLE IF NOT EXISTS sulla_settings (
    property TEXT PRIMARY KEY,
    value TEXT
  );
`;

export const down = `DROP TABLE IF EXISTS sulla_settings;`;
