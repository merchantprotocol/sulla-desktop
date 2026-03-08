// SlackClient.ts
// Singleton wrapper around @slack/bolt (Socket Mode) for desktop/local AI agent
// Exposes high-level methods for sending messages, reacting, fetching users/history/etc.
// Handles connection lifecycle, graceful shutdown, reconnection

import { App, LogLevel } from '@slack/bolt';
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';
import type { ChatPostMessageResponse } from '@slack/web-api';
import type { WebAPICallResult } from '@slack/web-api';
import {
  WebSocketClientService,
  type WebSocketMessage,
} from '../../services/WebSocketClientService';

import {
  getIntegrationService,
  type IntegrationValue,
} from '../../services/IntegrationService';
import { GraphRegistry, nextMessageId } from '../../services/GraphRegistry';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import type { AgentGraphState } from '../../nodes/Graph';
import { withSuppressedConnectionStatus } from '../integrationFlags';
import { incomingMessage } from './prompts/incoming_message';


const INTEGRATION_ID = 'slack';
const TOKEN_PROPERTY = 'bot_token';
const APP_TOKEN_PROPERTY = 'scopes_token';
const APP_TOKEN_FALLBACK_PROPERTIES = ['app_token', 'app_level_token'];

const WS_SERVICE = WebSocketClientService.getInstance();
const SLACK_GRAPH_CHANNEL = 'slack-direct';

function generateUUID(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback random fill
    for (let i = 0; i < 16; i++) {
      bytes[i] = (Math.random() * 256) | 0;
    }
  }

  // Set version 4 bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant bits
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

function extractMessageFacts(args: any): string[] {
  const facts: string[] = [];
  const event = args.event;
  const message = args.message;
  
  facts.push(`Event Type: ${event.type}`);
  facts.push(`User ID: ${event.user}`);
  facts.push(`Channel: ${event.channel}`);
  facts.push(`Channel Type: ${event.channel_type || 'unknown'}`);
  facts.push(`Timestamp: ${event.ts}`);
  facts.push(`Message Text: "${event.text || 'No text'}"`);
  
  if (event.thread_ts) {
    facts.push(`Thread Timestamp: ${event.thread_ts}`);
  }
  
  if (message.subtype) {
    facts.push(`Message Subtype: ${message.subtype}`);
  }
  
  if (message.blocks && message.blocks.length > 0) {
    facts.push(`Has Blocks: Yes (${message.blocks.length} blocks)`);
  }
  
  return facts;
}

export class SlackClient {
  private app: App | null = null;
  private connected = false;
  private initializePromise: Promise<boolean> | null = null;
  private lastInitializeError: string | null = null;
  private intentionallyClosed = false;
  private eventsRegistered = false;

  private static instance: SlackClient | null = null;

  private constructor() {}

  public static getInstance(): SlackClient {
    if (!SlackClient.instance) {
      SlackClient.instance = new SlackClient();
    }
    return SlackClient.instance;
  }
  private botToken?: string;
  private appToken?: string;

  isConnected(): boolean {
    return this.connected && this.app !== null;
  }

  getLastInitializeError(): string | null {
    return this.lastInitializeError;
  }

  private normalizeTokens(botToken?: string, appToken?: string): { botToken: string; appToken: string } | null {
    const bot = (botToken || '').trim();
    const app = (appToken || '').trim();

    if (!bot || !app) {
      return null;
    }

    // Common misconfiguration: app/bot tokens entered in opposite fields.
    if (bot.startsWith('xapp-') && app.startsWith('xoxb-')) {
      return { botToken: app, appToken: bot };
    }

    return { botToken: bot, appToken: app };
  }

  setTokens(botToken: string, appToken: string): void {
    this.botToken = botToken;
    this.appToken = appToken;
  }

  /**
   * Monitor Bolt's built-in SocketModeClient lifecycle events.
   * We do NOT null out this.app or fight Bolt's auto-reconnect.
   * We only track our connected flag for health reporting.
   */
  private bindSocketLifecycleHandlers(): void {
    const socketClient = (this.app as any)?.receiver?.client;
    if (!socketClient || typeof socketClient.on !== 'function') {
      console.warn('[SlackClient] Could not bind socket lifecycle handlers — receiver.client not available');
      return;
    }

    // Bolt's SocketModeClient emits these states as events
    socketClient.on('connected', () => {
      console.log('[SlackClient] SocketModeClient connected event');
      this.connected = true;
    });

    socketClient.on('authenticated', () => {
      console.log('[SlackClient] SocketModeClient authenticated event');
    });

    socketClient.on('reconnecting', () => {
      console.warn('[SlackClient] SocketModeClient reconnecting...');
      this.connected = false;
    });

    socketClient.on('disconnected', () => {
      if (this.intentionallyClosed) return;
      console.warn('[SlackClient] SocketModeClient disconnected event');
      this.connected = false;
    });

    socketClient.on('close', () => {
      if (this.intentionallyClosed) return;
      console.warn('[SlackClient] SocketModeClient close event — Bolt will auto-reconnect');
      this.connected = false;
    });

    socketClient.on('error', (error: unknown) => {
      console.error('[SlackClient] SocketModeClient error:', error);
    });
  }

  private buildSlackThreadGraphId(event: any): string {
    const channel = String(event?.channel || 'unknown');
    const threadTs = String(event?.thread_ts || event?.ts || Date.now());
    return `slack_${channel}_${threadTs}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private async executeAgentGraphForSlack(content: string, threadId: string): Promise<string> {
    const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(SLACK_GRAPH_CHANNEL, threadId) as {
      graph: any;
      state: AgentGraphState;
    };

    const mode = await SullaSettingsModel.get('modelMode', 'local');
    state.metadata.llmLocal = mode === 'local';
    state.metadata.llmModel = mode === 'remote'
      ? await SullaSettingsModel.get('remoteModel', '')
      : await SullaSettingsModel.get('sullaModel', '');

    state.metadata.wsChannel = SLACK_GRAPH_CHANNEL;
    state.messages.push({
      id: nextMessageId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      metadata: { source: 'slack' },
    } as any);

    state.metadata.cycleComplete = false;
    state.metadata.waitingForUser = false;

    try {
      await graph.execute(state, 'input_handler');

      // Extract response: check agent metadata first, then fall back to latest assistant message
      const agentMeta = (state.metadata as any).agent;
      if (agentMeta?.response?.trim()) return agentMeta.response.trim();
      if (agentMeta?.status_report?.trim()) return agentMeta.status_report.trim();

      const finalSummary = state.metadata.finalSummary?.trim();
      if (finalSummary) return finalSummary;

      const latestAssistant = [...state.messages].reverse().find((msg: any) => msg.role === 'assistant');
      if (latestAssistant?.content) {
        return typeof latestAssistant.content === 'string'
          ? latestAssistant.content
          : JSON.stringify(latestAssistant.content);
      }

      return '';
    } finally {
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
    }
  }

  private async handleAppMention(event: any): Promise<void> {
    const mentionText = String(event?.text || '').trim();
    const messageId = generateUUID();
    const fullMessage = `
SLACK APP MENTION
- Channel: ${event?.channel || 'unknown'}
- User ID: ${event?.user || 'unknown'}
- Thread TS: ${event?.thread_ts || event?.ts || 'none'}
- Message: ${mentionText || '(empty)'}

${incomingMessage}`.trim();

    console.log('[SlackClient] Running app_mention through AgentGraph directly', {
      messageId,
      slackChannel: event?.channel,
      slackThreadTs: event?.thread_ts || event?.ts,
      preview: mentionText.slice(0, 80),
    });

    const responseText = await this.executeAgentGraphForSlack(fullMessage, this.buildSlackThreadGraphId(event));
    if (!responseText.trim()) {
      console.warn('[SlackClient] Empty AgentGraph response for app_mention', { messageId });
      return;
    }

    const channel = String(event?.channel || '').trim();
    const threadTs = String(event?.thread_ts || event?.ts || '').trim();
    if (!channel || !threadTs) {
      console.warn('[SlackClient] Missing Slack channel/thread for app_mention reply', {
        messageId,
        channel,
        threadTs,
      });
      return;
    }

    await this.replyInThread(channel, threadTs, responseText);
    console.log('[SlackClient] Replied to Slack app_mention thread', {
      messageId,
      channel,
      threadTs,
    });
  }

  /**
   * Register Bolt event/message handlers. Only done once per App instance.
   */
  private registerEventHandlers(): void {
    if (this.eventsRegistered || !this.app) return;
    this.eventsRegistered = true;

    this.app.event(/.*/, async (args) => {
      console.log('[SlackClient] Event received:', args.event.type, args.event);

      const event: any = args.event;
      if (event?.type === 'app_mention') {
        try {
          await this.handleAppMention(event);
        } catch (error) {
          console.error('[SlackClient] Failed processing app_mention directly', error);
        }
        return;
      }

      const slackEventForwardId = generateUUID();
      console.log('[SlackClient] Forwarding slack_event to tasker channel', {
        channel: SLACK_GRAPH_CHANNEL,
        messageId: slackEventForwardId,
        eventType: args.event.type || 'unknown',
      });

      WS_SERVICE.send(SLACK_GRAPH_CHANNEL, {
        type: 'slack_event',
        data: {
          type: args.event.type || 'unknown',
          event: args.event,
          context: args.context,
        },
        id: slackEventForwardId,
        timestamp: Date.now(),
        channel: SLACK_GRAPH_CHANNEL,
      });
    });

    this.app.message(async (args) => {
      const event: any = args.event;
      console.log('[SlackClient] Message landed', event.text);
      if (args.message.subtype === 'bot_message') return;

      const facts = extractMessageFacts(args);
      const factsText = facts.map(fact => `- ${fact}`).join('\n');
      const fullMessage = `${factsText}\n\n${incomingMessage}`;

      WS_SERVICE.send(SLACK_GRAPH_CHANNEL, {
        type: 'user_message',
        data: { content: fullMessage },
        id: generateUUID(),
        timestamp: Date.now(),
        channel: SLACK_GRAPH_CHANNEL,
      });
    });

    this.app.error(async (error) => {
      console.error('[SlackClient] Bolt error:', error);
    });
  }

  async initialize(): Promise<boolean> {
    if (this.connected && this.app) return true;
    if (this.initializePromise) return this.initializePromise;

    this.intentionallyClosed = false;
    this.lastInitializeError = null;

    this.initializePromise = this._doInitialize();

    try {
      return await this.initializePromise;
    } catch (err) {
      this.lastInitializeError = (err as Error)?.message || String(err);
      throw err;
    } finally {
      this.initializePromise = null;
    }
  }

  private async _doInitialize(): Promise<boolean> {
    console.log('[SlackClient] _doInitialize() entered', {
      hasApp: !!this.app,
      connected: this.connected,
      intentionallyClosed: this.intentionallyClosed,
      hasInjectedBot: !!this.botToken,
      hasInjectedApp: !!this.appToken,
    });

    // If we have a stale app instance, stop it cleanly first
    if (this.app) {
      console.log('[SlackClient] Stopping stale app instance before re-init');
      await this.stopApp();
    }

    const service = getIntegrationService();
    await service.initialize();

    // Prefer injected tokens → fallback to DB → fallback to env vars
    let botToken = this.botToken;
    let appToken = this.appToken;

    if (!botToken || !appToken) {
      console.log('[SlackClient] Tokens not injected, resolving from DB/env...');
      const appRows = await Promise.all([
        service.getIntegrationValue(INTEGRATION_ID, APP_TOKEN_PROPERTY),
        ...APP_TOKEN_FALLBACK_PROPERTIES.map(property =>
          service.getIntegrationValue(INTEGRATION_ID, property)
        ),
      ]);
      const botRow = await service.getIntegrationValue(INTEGRATION_ID, TOKEN_PROPERTY);

      botToken = botToken || botRow?.value || process.env.SLACK_BOT_TOKEN;
      appToken = appToken || appRows.find(row => !!row?.value)?.value || process.env.SLACK_APP_TOKEN;
      console.log('[SlackClient] Token resolution:', {
        hasBotToken: !!botToken,
        hasAppToken: !!appToken,
        botPrefix: botToken ? botToken.substring(0, 5) : 'none',
        appPrefix: appToken ? appToken.substring(0, 5) : 'none',
      });
    }

    const normalizedTokens = this.normalizeTokens(botToken, appToken);
    if (!normalizedTokens) {
      throw new Error('[SlackClient] No Slack tokens available (injected or DB)');
    }

    botToken = normalizedTokens.botToken;
    appToken = normalizedTokens.appToken;

    if (!botToken.startsWith('xoxb-')) {
      throw new Error('[SlackClient] Invalid Slack bot token format. Expected xoxb- token for Socket Mode bot auth.');
    }

    if (!appToken.startsWith('xapp-')) {
      throw new Error('[SlackClient] Invalid Slack app token format. Expected xapp- token to enable Socket Mode.');
    }

    console.log('[SlackClient] Creating Bolt App with Socket Mode...');
    this.app = new App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    // Register event/message handlers before start so they're ready
    this.eventsRegistered = false;
    this.registerEventHandlers();
    this.bindSocketLifecycleHandlers();

    WS_SERVICE.connect(SLACK_GRAPH_CHANNEL);

    try {
      console.log('[SlackClient] Calling app.start()...');
      await this.app.start();
      this.connected = true;
      console.log('[SlackClient] Socket Mode connected → forwarding to internal WS');

      // Mark connection healthy in DB (suppress listener to avoid self-destructive reload)
      try {
        await withSuppressedConnectionStatus(() => service.setConnectionStatus(INTEGRATION_ID, true));
      } catch (dbErr) {
        console.warn('[SlackClient] Could not update connection_status in DB:', dbErr);
      }

      return true;
    } catch (err) {
      console.error('[SlackClient] Startup failed:', err);
      this.connected = false;
      await this.stopApp();
      throw (err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async stopApp(): Promise<void> {
    const appToStop = this.app;
    this.app = null;
    this.connected = false;
    this.eventsRegistered = false;

    if (!appToStop) return;

    try {
      // Bolt App.stop() calls receiver.stop() which calls SocketModeClient.disconnect()
      await appToStop.stop();
      console.log('[SlackClient] Bolt App stopped cleanly');
    } catch (err) {
      console.warn('[SlackClient] Bolt App stop error (non-fatal):', err);
    }
  }

  // ────────────────────────────────────────────────
  // Core send methods (most common for AI agent)
  // ────────────────────────────────────────────────

  async sendMessage(
    channel: string,
    text: string,
    thread_ts?: string,
    blocks?: any[]
  ): Promise<ChatPostMessageResponse & { ts: string }> {
    await this.ensureConnected();
    const result = await this.app!.client.chat.postMessage({
      channel,
      text,
      thread_ts,
      blocks,
      mrkdwn: true,
    });
    
    if (!result.ts) {
      throw new Error('Slack API did not return a timestamp for the message');
    }
    
    return result as ChatPostMessageResponse & { ts: string };
  }

  async replyInThread(
    channel: string,
    thread_ts: string,
    text: string,
    blocks?: any[]
  ): Promise<WebAPICallResult & { ts: string }> {
    return this.sendMessage(channel, text, thread_ts, blocks);
  }

  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: any[]
  ): Promise<WebAPICallResult> {
    await this.ensureConnected();
    return this.app!.client.chat.update({ channel, ts, text, blocks });
  }

  async addReaction(channel: string, ts: string, reaction: string): Promise<WebAPICallResult> {
    await this.ensureConnected();
    return this.app!.client.reactions.add({ channel, timestamp: ts, name: reaction });
  }

  async removeReaction(channel: string, ts: string, reaction: string): Promise<WebAPICallResult> {
    await this.ensureConnected();
    return this.app!.client.reactions.remove({ channel, timestamp: ts, name: reaction });
  }

  async joinChannel(channelId: string): Promise<WebAPICallResult> {
    await this.ensureConnected();
    return this.app!.client.conversations.join({ channel: channelId });
  }

  // ────────────────────────────────────────────────
  // Fetch / read methods
  // ────────────────────────────────────────────────

  async listChannels(types: ('public_channel' | 'private_channel' | 'im' | 'mpim')[] = ['public_channel']): Promise<any[]> {
    await this.ensureConnected();
    let channels: any[] = [];
    let cursor: string | undefined;

    do {
        const response = await this.app!.client.conversations.list({
        types: types.join(','),
        limit: 1000,
        cursor,
        });

        channels = channels.concat(response.channels ?? []);
        cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    return channels;
  }

  async getUserInfo(userId: string): Promise<any> {
    await this.ensureConnected();
    const res = await this.app!.client.users.info({ user: userId });
    return res.user;
  }

  async apiCall(method: string, params: Record<string, any> = {}): Promise<any> {
    await this.ensureConnected();
    return this.app!.client.apiCall(method, params);
  }

  async searchUsers(query: string, limit = 10): Promise<any[]> {
    await this.ensureConnected();

    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      return [];
    }

    let users: any[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.app!.client.users.list({
        limit: 200,
        cursor,
      });

      users = users.concat(response.members ?? []);
      cursor = response.response_metadata?.next_cursor;

      if (users.length >= 2000) {
        break;
      }
    } while (cursor);

    return users
      .filter((user: any) => !user?.deleted && !user?.is_bot)
      .filter((user: any) => {
        const name = String(user?.name || '').toLowerCase();
        const realName = String(user?.real_name || user?.profile?.real_name || '').toLowerCase();
        const displayName = String(user?.profile?.display_name || '').toLowerCase();
        const email = String(user?.profile?.email || '').toLowerCase();

        return name.includes(q) || realName.includes(q) || displayName.includes(q) || email.includes(q);
      })
      .slice(0, Math.max(1, limit));
  }

  async getChannelHistory(
    channel: string,
    limit = 50,
    oldest?: string,
    latest?: string
  ): Promise<any[]> {
    await this.ensureConnected();
    const res = await this.app!.client.conversations.history({
      channel,
      limit,
      oldest,
      latest,
      inclusive: true,
    });
    return res.messages ?? [];
  }

  async getThreadReplies(channel: string, ts: string): Promise<any[]> {
    await this.ensureConnected();
    const res = await this.app!.client.conversations.replies({ channel, ts });
    return res.messages ?? [];
  }

  // ────────────────────────────────────────────────
  // Event registration (for your AI agent to hook into)
  // Call these in your main app init after initialize()
  // ────────────────────────────────────────────────

  onMessage(
    callback: (args: SlackEventMiddlewareArgs<'message'> & AllMiddlewareArgs) => Promise<void>
  ): void {
    this.app!.message(async (args) => {
      // Filter out bot messages if desired
      if (args.message.subtype === 'bot_message') return;
      await callback(args);
    });
  }

  onMention(
    callback: (args: SlackEventMiddlewareArgs<'app_mention'> & AllMiddlewareArgs) => Promise<void>
  ): void {
    this.app!.event('app_mention', callback);
  }

  onDM(
    callback: (args: SlackEventMiddlewareArgs<'message'> & AllMiddlewareArgs) => Promise<void>
  ): void {
    this.app!.message(/./, async (args) => {  // all messages
      if (args.message.channel_type !== 'im') return;
      await callback(args);
    });
  }

  // Add more: app.event('channel_joined'), app.event('reaction_added'), etc.

  async close(): Promise<void> {
    this.intentionallyClosed = true;
    console.log('[SlackClient] Intentional close requested');
    await this.stopApp();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      const ok = await this.initialize();
      if (!ok) throw new Error('[SlackClient] Not connected');
    }
  }
}

export const slackClient = SlackClient.getInstance();