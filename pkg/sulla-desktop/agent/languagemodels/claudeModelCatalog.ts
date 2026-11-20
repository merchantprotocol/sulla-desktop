// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { sharedModelCatalog } from './sharedModelCatalog';

export interface ClaudeCatalogModel {
  id: string; name: string; description?: string;
  efforts?: { id: string; description?: string }[];
  defaultEffort?: string; selectionMode?: 'exact' | 'alias' | 'automatic' | 'policy';
}

// Compatibility exports only; sharedModelCatalog owns the sole cache and source.
export function initializeMainClaudeModelCatalogBoundary(): void {}
export function clearClaudeModelCatalogCache(): void {}

export async function listClaudeCodeModels(_opts?: { force?: boolean }): Promise<ClaudeCatalogModel[]> {
  return (await sharedModelCatalog.listModels('claude-code')).map(model => ({
    id: model.id, name: model.name, selectionMode: model.selectionMode === 'auto' ? 'automatic' : model.selectionMode,
    ...(model.supportedReasoningEfforts ? { efforts: model.supportedReasoningEfforts.map(id => ({ id })) } : {}),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
  }));
}
