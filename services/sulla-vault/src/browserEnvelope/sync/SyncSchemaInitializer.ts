// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Applies the Passwords sync v3 bookkeeping schema once per initializer. A
// failed apply is not remembered, so the next call retries.

import type { Queryable } from '../../db.js';
import { PostgresSyncSchemaRepository } from './repositories/PostgresSyncSchemaRepository.js';

export class SyncSchemaInitializer {
  private ensured = false;

  constructor(private readonly schema: PostgresSyncSchemaRepository = new PostgresSyncSchemaRepository()) {}

  async ensure(db: Queryable): Promise<void> {
    if (this.ensured) return;
    await this.schema.apply(db);
    this.ensured = true;
  }
}
