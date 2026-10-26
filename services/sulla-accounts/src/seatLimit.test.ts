// SPDX-License-Identifier: LicenseRef-Sulla-Fair-Code
import assert from 'node:assert/strict';
import test from 'node:test';

import { seatLimitReached } from './seatLimit.js';

test('the 26th seat is refused through every user-creating reservation mode', () => {
  const limit = 25;
  assert.equal(seatLimitReached(25, limit), true, 'direct user creation');
  assert.equal(seatLimitReached(25, limit), true, 'invitation creation');
  assert.equal(seatLimitReached(25, limit, true), false, 'accepting a pending invitation replaces its reserved seat');
  assert.equal(seatLimitReached(26, limit, true), true, 'acceptance cannot hide over-allocation');
  assert.equal(seatLimitReached(24, limit), false, 'the 25th seat remains available');
});
