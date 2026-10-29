// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Lightweight manifest registration — plain data only, no tool worker imports.
// Each category manifests.ts holds schemaDefs inline and uses dynamic import()
// for lazy-loading workers. This keeps the webpack bundle small at startup.

import { allToolManifests } from './allManifests';
import { toolRegistry } from './registry';

toolRegistry.registerManifests(allToolManifests);
