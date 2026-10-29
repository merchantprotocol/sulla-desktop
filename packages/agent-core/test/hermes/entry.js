// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Hermes entry: runs the golden transcripts and prints one result line.
/* global print */

import * as core from '../../dist/index.js';
import { fixtures } from '../golden/fixtures.js';
import { runGolden } from '../golden/runGolden.js';

runGolden(core, fixtures).then(
  results => print(`GOLDEN_RESULT ${ JSON.stringify(results) }`),
  err => print(`GOLDEN_ERROR ${ err && err.stack ? err.stack : String(err) }`),
);
