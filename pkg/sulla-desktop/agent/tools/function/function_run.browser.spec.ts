// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { FunctionTimeoutParser } from './function_run';

describe('FunctionTimeoutParser', () => {
  it('uses a direct function manifest timeout for browser capability lifetime', () => { // risk: overlong capability
    const parser = new FunctionTimeoutParser();
    expect(parser.parse('37s')).toBe(37_000);
    expect(parser.parse('1500ms')).toBe(1_500);
    expect(parser.parse('2m')).toBe(120_000);
  });
});
