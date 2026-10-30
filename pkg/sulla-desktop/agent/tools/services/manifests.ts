// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolManifest } from '../registry';

export const serviceToolManifests: ToolManifest[] = [
  { name: 'services_where', description: 'Resolve a local Sulla service to its current sticky host port and origin.', category: 'services', schemaDef: { service: { type: 'string', description: 'Service name, for example vault, files, tools, postgres, chat.' }, protocol: { type: 'string', optional: true, description: 'Origin protocol (default http).' } }, operationTypes: ['read'], loader: () => import('./where') },
  { name: 'services_list', description: 'List all local Sulla services and their current sticky host ports.', category: 'services', schemaDef: {}, operationTypes: ['read'], loader: () => import('./list') },
];
