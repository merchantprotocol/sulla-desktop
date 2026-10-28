// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolManifest } from '../registry';

export const episodicToolManifests: ToolManifest[] = [
  {
    name:           'episodic_resolve',
    category:       'memory',
    operationTypes: ['read'],
    description:    'Resolve aliases to canonical active Knowledge Base nodes.',
    schemaDef:      { terms: { type: 'array', items: { type: 'string' }, description: 'Terms to resolve.' } },
    loader:         () => import('./resolve'),
  },
  {
    name:           'episodic_search',
    category:       'memory',
    operationTypes: ['read'],
    description:    'Search durable conversation history and message content. Empty query lists recent conversations.',
    schemaDef:      {
      query:            { type: 'string', optional: true, description: 'Conversation title, summary, or message-content query. Empty lists recent conversations.' },
      include_archived: { type: 'boolean', optional: true, description: 'Include archived conversations.' },
      limit:            { type: 'number', optional: true, description: 'Bounded result limit.' },
    },
    loader: () => import('./search'),
  },
  {
    name:           'episodic_recall',
    category:       'memory',
    operationTypes: ['read'],
    description:    'Recall Knowledge Base nodes by query or alias. Read-only.',
    schemaDef:      {
      query:             { type: 'string', optional: true, description: 'Fallback title/summary query.' },
      terms:             { type: 'array', optional: true, items: { type: 'string' }, description: 'Fallback alias terms.' },
      limit:             { type: 'number', optional: true, description: 'Bounded result limit.' },
    },
    loader: () => import('./recall'),
  },
];
