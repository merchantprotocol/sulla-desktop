// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { HookRegistry } from '../../../extensions/HookRegistry';

describe('BL-040 extension before_tool_call contract', () => {
  // SPEC-FINDING SF-2c-01: HookRegistry treats an empty extension result as a replacement payload.
  it('passes the original payload through when a hook returns an empty object', async() => {
    const hooks = new HookRegistry({ granted: async() => true });
    hooks.register({ extensionId: 'empty-extension', hook: 'before_tool_call', handler: async() => ({}) });
    const payload = { toolName: 'files/search', args: { query: 'invoice' }, toolRunId: 'run-1' };
    expect((await hooks.runFilter('before_tool_call', payload)).value).toEqual(payload);
  });
});
