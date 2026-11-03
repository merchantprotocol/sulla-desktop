// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// Run: node --experimental-strip-types --test tests/cloud-settings-recommended.check.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recommendedConsentPatch } from '../pkg/sulla-desktop/main/cloud/cloudConsentInit.ts';

const RECOMMENDED_CLOUD_DATA_KINDS = ['workflows','skills','customAgents','recipes','useCases','liveAgents','usage','memory','conversations','files'];

test('recommended consent enables only the recommended categories and master switch', () => {
  const patch = recommendedConsentPatch(RECOMMENDED_CLOUD_DATA_KINDS);
  assert.equal(patch.enabled, true);
  for (const kind of RECOMMENDED_CLOUD_DATA_KINDS) assert.equal(patch[kind], true, kind);
  assert.equal('vault' in patch, false);
  assert.equal('remoteAccess' in patch, false);
});

test('recommended consent leaves both sensitive preferences available to preserve', () => {
  const patch = recommendedConsentPatch(RECOMMENDED_CLOUD_DATA_KINDS);
  for (const vault of [false, true]) {
    for (const remoteAccess of [false, true]) {
      assert.equal(patch.vault ?? vault, vault);
      assert.equal(patch.remoteAccess ?? remoteAccess, remoteAccess);
    }
  }
});
