// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, test } from '@jest/globals';

import { isBlockedDesktopTarget } from '../../desktop/desktop';
import { toolRequiresHostAccess } from '../hostAccessPolicy';

describe('desktop security boundaries', () => {
  test.each(['Keychain Access', '1Password', 'Bitwarden', 'Wallet — localhost:4777/home'])(
    'privacy denylist blocks %s', target => expect(isBlockedDesktopTarget(target)).toBe(true),
  );

  test('desktop category always requires Administrative Access', () => {
    for (const name of ['snapshot', 'act', 'screenshot', 'permissions']) {
      expect(toolRequiresHostAccess('desktop', name)).toBe(true);
    }
  });
});
