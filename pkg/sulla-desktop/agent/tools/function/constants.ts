// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { serviceOrigin } from '@pkg/main/serviceDirectory';

export const RUNTIME_URLS: Record<string, string> = {
  python: serviceOrigin('runtime-python'),
  shell:  serviceOrigin('runtime-shell'),
  node:   serviceOrigin('runtime-node'),
};

// File that signals a runtime has installable dependencies for a function.
export const DEPS_FILES: Record<string, string> = {
  python: 'requirements.txt',
  node:   'package.json',
  shell:  'packages.txt',
};
