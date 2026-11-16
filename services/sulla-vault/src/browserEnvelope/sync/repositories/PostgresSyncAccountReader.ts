// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Read-only view of the local account wrap for building Cloud bundles (DESIGN-V6 D3: pure move).
// Sync reads `users` and `local_vault_recovery`; it has no method that writes them, by design
// (rule: the local vault key is never rewrapped by sync).

import type { Queryable } from '../../../db.js';
import type { LocalAccountRow, LocalRecoveryRow } from '../../exportBuilder.js';

export class PostgresSyncAccountReader {
  async account(q: Queryable, userId: string): Promise<LocalAccountRow | null> {
    const result = await q.query<LocalAccountRow>(
      'SELECT id,public_key,encrypted_private_key,encrypted_user_key,kdf FROM users WHERE id=$1 AND disabled_at IS NULL', [userId],
    );
    return result.rows[0] ?? null;
  }

  async recovery(q: Queryable, userId: string): Promise<LocalRecoveryRow | null> {
    const result = await q.query<LocalRecoveryRow>(
      'SELECT recovery_salt,encrypted_user_key FROM local_vault_recovery WHERE user_id=$1', [userId],
    );
    return result.rows[0] ?? null;
  }
}
