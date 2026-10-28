// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, test } from '@jest/globals';

import { commandExecutionTarget } from '../CommandRunner';

describe('CommandRunner container boundary', () => {
  test('a bound container cannot be overridden by the legacy guest flag', () => {
    expect(commandExecutionTarget(true, false)).toBe('container');
    expect(commandExecutionTarget(true, true)).toBe('container');
    expect(commandExecutionTarget(false, true)).toBe('vm');
  });
});
