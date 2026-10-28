// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Express } from 'express';
export const WORKFLOWS_ADAPTER_API_VERSION = 1 as const;
export interface WorkflowsAdapter {
  readonly apiVersion: typeof WORKFLOWS_ADAPTER_API_VERSION;
  register(app: Express, context: Readonly<{ role: 'manager' | 'runner'; mode: 'server' }>): void | Promise<void>;
}
export function assertWorkflowsAdapter(adapter: WorkflowsAdapter | undefined): asserts adapter is WorkflowsAdapter {
  if (adapter?.apiVersion !== WORKFLOWS_ADAPTER_API_VERSION || typeof adapter.register !== 'function') {
    throw new Error(`Workflows adapter API ${WORKFLOWS_ADAPTER_API_VERSION} is required`);
  }
}
