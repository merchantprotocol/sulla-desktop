// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ConversationServersCloudClient } from './ConversationServersCloudClient';

describe('ConversationServersCloudClient', () => {
  it('uses the documented per-member preference contract, including null to inherit', async () => {
    // risk: permissions and data accuracy; notification choices must be persisted only through the scoped API contract
    const calls: { method: string; path: string; body?: string }[] = [];
    const client = new ConversationServersCloudClient(async (method, path, init) => {
      calls.push({ method, path, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ level: 'mentions', preference: null, channelOverride: 'mentions', serverDefault: 'all' }), { status: 200 });
    });

    const preference = await client.channelPreference('server/1', 'channel 2');
    await client.setChannelPreference('server/1', 'channel 2', 'nothing');
    await client.setChannelPreference('server/1', 'channel 2', null);

    expect(preference).toMatchObject({ level: 'mentions', preference: null, channelOverride: 'mentions', serverDefault: 'all' });
    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ['GET', '/conversation-servers/server%2F1/channels/channel%202/notification-preference'],
      ['PUT', '/conversation-servers/server%2F1/channels/channel%202/notification-preference'],
      ['PUT', '/conversation-servers/server%2F1/channels/channel%202/notification-preference'],
    ]);
    expect(calls.slice(1).map(call => JSON.parse(call.body ?? 'null'))).toEqual([{ level: 'nothing' }, { level: null }]);
  });

  it('surfaces failed API reads instead of presenting fabricated empty server data', async () => {
    // risk: data accuracy; a denied/failed Cloud read must not look like an actually empty public server list
    const client = new ConversationServersCloudClient(async () => new Response('{}', { status: 503 }));
    await expect(client.list()).rejects.toThrow('Conversation servers unavailable (503)');
  });

  it('uses the channel message, cursor and unread contracts without accepting invalid sends or cursors', async () => {
    // risk: message delivery and read-state accuracy; sends must be scoped and invalid cursors must never advance read state
    const calls: { method: string; path: string; body?: string }[] = [];
    const client = new ConversationServersCloudClient(async (method, path, init) => {
      calls.push({ method, path, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ messages: [{ id: 'm1', seq: 9, body: 'hello' }], latestSeq: 9 }), { status: 200 });
    });
    await client.messages('server/1', 'channel 2', 12);
    await client.sendMessage('server/1', 'channel 2', ' hello ');
    await client.markRead('server/1', 'channel 2', 9);
    await client.unread('server/1');
    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ['GET', '/conversation-servers/server%2F1/channels/channel%202/messages?limit=50&before=12'],
      ['POST', '/conversation-servers/server%2F1/channels/channel%202/messages'],
      ['POST', '/conversation-servers/server%2F1/channels/channel%202/read'],
      ['GET', '/conversation-servers/server%2F1/unread'],
    ]);
    expect(JSON.parse(calls[1].body ?? 'null')).toEqual({ body: 'hello' });
    expect(JSON.parse(calls[2].body ?? 'null')).toEqual({ seq: 9 });
    expect(() => client.sendMessage('s', 'c', '   ')).toThrow('between 1 and 4000');
    expect(() => client.markRead('s', 'c', -1)).toThrow('Invalid read cursor');
  });
});
