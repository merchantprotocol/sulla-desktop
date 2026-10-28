// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const LEGACY_ALLOW_LIMIT = 2_147_483_647;

export interface WorkflowConcurrencyDefinition {
  maxConcurrentRuns?: unknown;
  concurrencyPolicy?: unknown;
}

/**
 * New definitions use an explicit positive integer. Legacy singleton and
 * allow-policy definitions keep their old behavior when the field is absent.
 */
export function workflowConcurrencyLimit(definition: WorkflowConcurrencyDefinition): number {
  const configured = definition.maxConcurrentRuns;
  if (typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0) return configured;
  if (definition.concurrencyPolicy === 'allow') return LEGACY_ALLOW_LIMIT;
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

export function isSingletonWorkflow(definition: WorkflowConcurrencyDefinition): boolean {
  return workflowConcurrencyLimit(definition) === 1;
}
