// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Node runtime: golden transcripts. Workers and Hermes run the same
// fixtures through test/workers/run.mjs and test/hermes/run.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as core from '../dist/index.js';

import { fixtures } from './golden/fixtures.js';
import { runGolden } from './golden/runGolden.js';

const results = await runGolden(core, fixtures);

for (const r of results) {
  test(`golden (node): ${ r.name }`, () => {
    assert.deepEqual(r.problems, []);
  });
}
