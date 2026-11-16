// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

/** Relay ids are capability handles: random v4 UUIDs, never derived from request data. */
export class RelayIdGenerator {
  constructor(private readonly uuid: () => string = () => randomUUID()) {}

  next(): string {
    return this.uuid();
  }
}
