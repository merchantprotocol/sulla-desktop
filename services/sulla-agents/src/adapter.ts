// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Express } from 'express';

export const AGENTS_ADAPTER_API_VERSION = 1 as const;
export interface AgentsAdapter {
  readonly apiVersion: typeof AGENTS_ADAPTER_API_VERSION;
  register(app: Express, context: Readonly<{ mode: 'server' }>): void | Promise<void>;
}
export function assertAgentsAdapter(adapter: AgentsAdapter | undefined): asserts adapter is AgentsAdapter {
  if (adapter?.apiVersion !== AGENTS_ADAPTER_API_VERSION || typeof adapter.register !== 'function') {
    throw new Error(`Agents adapter API ${AGENTS_ADAPTER_API_VERSION} is required`);
  }
}
