// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { loopbackOrigin } from '@pkg/utils/instance';

export const RUNTIME_URLS: Record<string, string> = {
  python: loopbackOrigin('http', 30118),
  shell:  loopbackOrigin('http', 30119),
  node:   loopbackOrigin('http', 30120),
};

// File that signals a runtime has installable dependencies for a function.
export const DEPS_FILES: Record<string, string> = {
  python: 'requirements.txt',
  node:   'package.json',
  shell:  'packages.txt',
};
