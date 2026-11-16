// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: DiscordClient used discord.js `Events.*` without importing `Events`,
// so registering the message/guild handlers threw a ReferenceError at startup.
// risk: integration startup — a broken import silently disables Discord intake.

const fake = vi.hoisted(() => {
  class FakeDiscordClient {
    static instances: FakeDiscordClient[] = [];
    handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    login = vi.fn(async(_token: string) => 'ok');

    constructor(public readonly options: unknown) {
      FakeDiscordClient.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    once(event: string, handler: (...args: unknown[]) => unknown): this {
      return this.on(event, handler);
    }
  }

  return {
    FakeDiscordClient,
    wsSend:       vi.fn(),
    wsConnect:    vi.fn(),
    setConnected: vi.fn(async(_id: string, _connected: boolean) => undefined),
  };
});

vi.mock('discord.js', () => ({
  Client:          fake.FakeDiscordClient,
  GatewayIntentBits: {
    Guilds:                  1,
    GuildMessages:           2,
    MessageContent:          4,
    GuildMessageReactions:   8,
    DirectMessages:          16,
    DirectMessageReactions:  32,
  },
  ChannelType: { GuildText: 0, DM: 1 },
  Events:      {
    MessageCreate: 'messageCreate',
    GuildCreate:   'guildCreate',
  },
}));

vi.mock('electron', () => ({
  app:       { getPath: vi.fn(() => '/tmp/sulla-test'), isPackaged: false },
  ipcMain:   { handle: vi.fn(), on: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}));

vi.mock('../../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => false,
}));

vi.mock('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({
    initialize:          async() => undefined,
    getIntegrationValue: async() => ({ value: 'test-bot-token' }),
    setConnectionStatus: fake.setConnected,
  }),
}));

vi.mock('../../../services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({
    connect: fake.wsConnect,
    send:    fake.wsSend,
  }),
}));

vi.mock('../../../integrations/discord/prompts/incoming_message', () => ({
  incomingMessage: 'PROMPT',
}));

describe('DiscordClient event handler registration', () => {
  beforeEach(() => {
    vi.resetModules();
    fake.FakeDiscordClient.instances.length = 0;
    fake.wsSend.mockClear();
    fake.wsConnect.mockClear();
    fake.setConnected.mockClear();
  });

  it('registers messageCreate and guildCreate handlers using discord.js Events when started', async() => {
    const { DiscordClient } = await import('../../../integrations/discord/DiscordClient');
    const client = DiscordClient.getInstance();

    const started = await client.initialize();

    expect(started).toBe(true);
    expect(fake.FakeDiscordClient.instances).toHaveLength(1);

    const discord = fake.FakeDiscordClient.instances[0];
    expect(discord.login).toHaveBeenCalledWith('test-bot-token');
    expect(discord.handlers.get('messageCreate')).toHaveLength(1);
    expect(discord.handlers.get('guildCreate')).toHaveLength(1);
    expect(fake.setConnected).toHaveBeenLastCalledWith('discord', true);
  });

  it('forwards a guild join to the internal websocket as a guild_join event', async() => {
    const { DiscordClient } = await import('../../../integrations/discord/DiscordClient');
    await DiscordClient.getInstance().initialize();

    const [guildCreate] = fake.FakeDiscordClient.instances[0].handlers.get('guildCreate') ?? [];
    guildCreate?.({ id: 'g1', name: 'Test Guild', memberCount: 3 });

    expect(fake.wsSend).toHaveBeenCalledTimes(1);
    expect(fake.wsSend).toHaveBeenCalledWith(
      'heartbeat',
      expect.objectContaining({
        type: 'discord_event',
        data: {
          type:  'guild_join',
          guild: { id: 'g1', name: 'Test Guild', memberCount: 3 },
        },
      }),
    );
  });

  it('ignores bot-authored messages on messageCreate', async() => {
    const { DiscordClient } = await import('../../../integrations/discord/DiscordClient');
    await DiscordClient.getInstance().initialize();

    const [messageCreate] = fake.FakeDiscordClient.instances[0].handlers.get('messageCreate') ?? [];
    await messageCreate?.({ author: { bot: true }, content: 'from a bot', attachments: new Map(), mentions: { users: new Map() } });

    expect(fake.wsSend).not.toHaveBeenCalled();
  });
});
