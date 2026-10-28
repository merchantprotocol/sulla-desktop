// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Enable query instrumentation when the PostgreSQL container preloads it. */
export const up = `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`;
export const down = `DROP EXTENSION IF EXISTS pg_stat_statements;`;
