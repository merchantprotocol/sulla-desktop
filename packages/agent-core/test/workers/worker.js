// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Workers entry: runs the golden transcripts inside workerd.

import * as core from '../../dist/index.js';
import { fixtures } from '../golden/fixtures.js';
import { runGolden } from '../golden/runGolden.js';

export default {
  async fetch() {
    const results = await runGolden(core, fixtures);
    return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json' } });
  },
};
