// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { ChatToolRequestSecurity } from '../../../../main/ChatToolRequestSecurity';

describe('ChatToolRequestSecurity', () => {
  it('preserves verified-session identity for answer_decision and leaves other tools on their ordinary path', () => {
    // risk: authorization — the server must not call answer_decision without the verified session identity.
    const security = new ChatToolRequestSecurity({
      header: vi.fn(() => ' session-123 '),
      headers: { authorization: 'Bearer token-123' },
    });
    const tool = {
      call: vi.fn(() => 'ordinary'),
      callWithVerifiedSession: vi.fn(() => 'verified'),
    };

    expect(security.sessionToken).toBe('session-123');
    expect(security.bearer).toBe('token-123');
    expect(security.invoke(tool, 'agents', 'answer_decision', 'holder-thread', {})).toBe('verified');
    expect(tool.callWithVerifiedSession).toHaveBeenCalledWith('holder-thread', {});
    expect(tool.call).not.toHaveBeenCalled();

    expect(security.invoke(tool, 'agents', 'send_job_message', 'holder-thread', {})).toBe('ordinary');
    expect(tool.call).toHaveBeenCalledOnce();
  });
});
