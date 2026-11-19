// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { A2aCardMarkup } from './a2aCardMarkup';

const marker = (card: object) => `⟦SULLA_A2A:${ Buffer.from(JSON.stringify(card)).toString('base64url') }⟧`;

describe('A2aCardMarkup', () => {
  it('persists and renders delivery status and reason on the matching card only', () => { // risk: delivery failures must not be hidden or attributed to another peer
    const first = marker({ id: 'message-1', to: 'reviewer', body: 'check this', status: 'sent' });
    const second = marker({ id: 'message-2', to: 'heartbeat', body: 'other', status: 'sent' });
    const markup = new A2aCardMarkup();
    const updated = markup.updateStatus(`${first}${second}`, { messageId: 'message-1', status: 'failed', reason: 'ambiguous target' });
    const rendered = markup.render(updated);
    expect(rendered).toContain('failed: ambiguous target');
    expect(rendered).toContain('other');
    expect(rendered).toContain('sent');
    expect(rendered).not.toContain('ambiguous target</div>');
  });
});
