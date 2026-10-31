// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';

import { CloudDeviceTransport, type CloudDeviceChannel } from '../CloudDeviceTransport';

function channel(handler?: (envelope: any) => any): CloudDeviceChannel {
  return {
    listDevices:  jest.fn<any>(),
    getManifest:  jest.fn<any>(),
    identity:     jest.fn<any>(async() => ({ userId: 'user-1', deviceId: 'desktop-1' })),
    sign:         jest.fn<any>((_parts: unknown, ts: number) => ({ ts, signature: 'signed-by-desktop-1' })),
    rpc:          jest.fn<any>(async(_deviceId: string, envelope: any) => handler?.(envelope)),
  };
}

const manifest = {
  appSlug: 'ai-visibility-lab',
  tools:   [{ name: 'list_projects', description: 'List projects', inputSchema: { type: 'object' as const } }],
};

describe('CloudDeviceTransport', () => {
  it('discovers and calls tools through signed W2 RPC envelopes', async() => {
    const mock = channel(envelope => envelope.body.method === 'tools/list'
      ? { result: { tools: manifest.tools } }
      : envelope.body.method === 'tools/call'
        ? { result: { content: [{ type: 'text', text: 'ok' }] } }
        : { result: {} });
    const transport = new CloudDeviceTransport('ai-visibility-lab', 'app-1', manifest, mock);

    await transport.initialize();
    await expect(transport.callTool('list_projects', { project_id: 'project-1' })).resolves.toMatchObject({
      success: true,
      content: [{ type: 'text', text: 'ok' }],
    });

    const calls = (mock.rpc as any).mock.calls;
    expect(calls.map(call => call[1].body.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
    for (const [target, envelope, signature] of calls) {
      expect(target).toBe('app-1');
      expect(envelope).toMatchObject({ v: 1, targetDeviceId: 'app-1', callerDeviceId: 'desktop-1' });
      expect(envelope.callId).toBe(envelope.body.id);
      expect(signature).toBe('signed-by-desktop-1');
    }
    expect(mock.sign).toHaveBeenCalledTimes(3);
    expect((mock.sign as any).mock.calls[2][0]).toEqual([
      'user-1', 'desktop-1', 'app-1', expect.any(String), expect.any(Number), expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it('returns an actionable message when Cloud reports the app offline', async() => {
    const mock = channel();
    (mock.rpc as any).mockRejectedValue(new Error('This Cloud app device is offline. Start it and try again.'));
    const transport = new CloudDeviceTransport('ai-visibility-lab', 'app-1', manifest, mock);
    await expect(transport.callTool('list_projects')).rejects.toThrow('offline');
  });
});
