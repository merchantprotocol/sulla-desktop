// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MCPServerHost } from '../MCPServerHost';
import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

describe('MCPServerHost streamable HTTP handshake', () => {
  it('acknowledges the initialized notification for stateless clients', async () => {
    const host = new MCPServerHost();
    await host.start();

    try {
      const session = host.registerSession({ metadata: {} } as BaseThreadState);
      const response = await fetch(`http://127.0.0.1:${ host.listeningPort }/mcp`, {
        method:  'POST',
        headers: {
          Authorization: session.header,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });

      expect(response.status).toBe(202);
    } finally {
      await host.stop();
    }
  });
});
