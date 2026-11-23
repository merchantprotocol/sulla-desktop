// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { SupportSessionCloudClient, type CloudRequester } from './supportSessionIpc';

describe('SupportSessionCloudClient.verifyRpc', () => {
  // risk: permissions — only the matching, successful audited status RPC is proof, and the output stays out of IPC.
  it('checks through the session RPC and returns only readiness', async () => {
    const request: CloudRequester = async(method, path, init) => {
      expect(method).toBe('POST');
      expect(path).toBe('/super-admin/support/sessions/session-one/rpc');
      const body = JSON.parse(init.body!);
      expect(body.params).toEqual({ name: 'support.update.status', arguments: {} });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: false, content: [{ type: 'text', text: 'remote payload' }] } });
    };
    await expect(new SupportSessionCloudClient(request).verifyRpc('session-one')).resolves.toEqual({ ready: true });
  });

  // risk: permissions — an unrelated reply, device error or denied supporter does not verify a session.
  it('rejects mismatched replies and device errors, and propagates Cloud authorization failure', async () => {
    const mismatch = new SupportSessionCloudClient(async() => Response.json({ jsonrpc: '2.0', id: 'other', result: { isError: false, content: [] } }));
    await expect(mismatch.verifyRpc('session-one')).resolves.toEqual({ ready: false });
    const toolError = new SupportSessionCloudClient(async(_m, _p, { body }) => Response.json({ jsonrpc: '2.0', id: JSON.parse(body!).id, result: { isError: true, content: [] } }));
    await expect(toolError.verifyRpc('session-one')).resolves.toEqual({ ready: false });
    const denied = new SupportSessionCloudClient(async() => Response.json({ error: 'supporter_mismatch' }, { status: 403 }));
    await expect(denied.verifyRpc('session-one')).rejects.toMatchObject({ status: 403, code: 'supporter_mismatch' });
  });
});
