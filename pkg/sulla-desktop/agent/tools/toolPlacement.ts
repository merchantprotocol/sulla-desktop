// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import policy from './tool-placement-policy.json';

import type { ToolOperation } from './base';

export type ToolPlacement = 'desktop' | 'cloud' | 'mobile';
export type ToolSideEffect = 'read' | 'write' | 'irreversible';
export type ToolCredential = 'none' | { integration: string } | { vaultItem: true };

export interface ToolPlacementMetadata {
  placements: ToolPlacement[];
  relayable: boolean;
  sideEffect: ToolSideEffect;
  credential: ToolCredential;
}

const familyFor = (category: string): keyof typeof policy.families | undefined =>
  (Object.entries(policy.families).find(([, categories]) => (categories as readonly string[]).includes(category))?.[0]) as
    keyof typeof policy.families | undefined;

export function defaultToolPlacementMetadata(
  name: string,
  category: string,
  operationTypes: ToolOperation[] = [],
): ToolPlacementMetadata {
  const family = familyFor(category);
  const sideEffect: ToolSideEffect = operationTypes.includes('delete') || policy.irreversibleTools.includes(name)
    ? 'irreversible'
    : operationTypes.length > 0 && operationTypes.every(operation => operation === 'read')
      ? 'read'
      : 'write';

  switch (family) {
  case 'integrations':
    return { placements: ['desktop', 'cloud', 'mobile'], relayable: true, sideEffect, credential: { integration: category } };
  case 'files':
    return { placements: ['desktop', 'mobile'], relayable: true, sideEffect, credential: 'none' };
  case 'vault':
    return { placements: ['desktop', 'mobile'], relayable: false, sideEffect, credential: { vaultItem: true } };
  case 'memory':
    return { placements: ['desktop', 'cloud', 'mobile'], relayable: false, sideEffect, credential: 'none' };
  case 'agents':
  case 'workflows':
    return { placements: ['desktop', 'cloud', 'mobile'], relayable: true, sideEffect, credential: 'none' };
  case 'desktopRelay':
    return { placements: ['desktop'], relayable: true, sideEffect, credential: 'none' };
  default:
    // Additive metadata must not make an unclassified tool available off Desktop.
    return { placements: ['desktop'], relayable: false, sideEffect, credential: 'none' };
  }
}
