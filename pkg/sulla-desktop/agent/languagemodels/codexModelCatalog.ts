// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { sharedModelCatalog } from './sharedModelCatalog';

export interface CodexCatalogModel {
  id: string; name: string; description?: string;
  efforts?: { id: string; description?: string }[];
  defaultEffort?: string; selectionMode?: 'exact' | 'alias' | 'automatic' | 'policy';
}

// Compatibility exports only; sharedModelCatalog owns the sole cache and source.
export function getLastCodexModelCatalogFailure(): string | undefined { return undefined; }
export function clearCodexModelCatalogCache(): void {}

export async function listCodexModels(_opts?: { force?: boolean }): Promise<CodexCatalogModel[]> {
  return (await sharedModelCatalog.listModels('codex')).map(model => ({
    id: model.id, name: model.name, selectionMode: model.selectionMode === 'auto' ? 'automatic' : model.selectionMode,
    ...(model.supportedReasoningEfforts ? { efforts: model.supportedReasoningEfforts.map(id => ({ id })) } : {}),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
  }));
}
