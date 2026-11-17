// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { ToolManifest } from '../registry';

export const budgetToolManifests: ToolManifest[] = [
  { name: 'budget_status', description: 'Read Budgeter policy, live hidden-worker count, and provider limit windows.', category: 'budget', schemaDef: {}, operationTypes: ['read'], loader: () => import('./status') },
  { name: 'budget_set_priority', description: 'Set the machine priority mode in Budgeter policy.', category: 'budget', schemaDef: { priority: { type: 'enum', enum: ['human-first', 'balanced', 'sulla-first'] }, until: { type: 'string', optional: true, description: 'Optional ISO-8601 expiry time.' } }, operationTypes: ['update'], loader: () => import('./set_priority') },
  { name: 'budget_set_policy', description: 'Set Budgeter worker and provider policies without changing machine priority.', category: 'budget', schemaDef: { policy: { type: 'object', description: 'Budget policy JSON with optional machine and provider settings.' } }, operationTypes: ['update'], loader: () => import('./set_policy') },
];
