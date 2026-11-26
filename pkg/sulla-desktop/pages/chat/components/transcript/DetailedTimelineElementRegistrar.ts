// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { TraceRow } from './traceTypes';

/** Keeps a trace row from replacing the target owned by a visible transcript entry. */
export class DetailedTimelineElementRegistrar {
  public constructor(private readonly registerElement: (id: string, element: unknown) => void) {}

  registerTrace(row: Pick<TraceRow, 'id'>, element: unknown, ownedMessageIds: ReadonlySet<string>): void {
    if (ownedMessageIds.has(row.id)) return;
    this.registerElement(row.id, element);
  }
}
