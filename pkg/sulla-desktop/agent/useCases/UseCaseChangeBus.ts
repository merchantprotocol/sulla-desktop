// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import type { SuggestionLogger, UseCaseChange, UseCaseChangeEvent, UseCaseChangeNotifier, UseCaseType } from './UseCaseSuggestionIndex';

/** Redis channel shared by every Sulla process that writes or indexes use case definitions. */
export const USE_CASE_CHANGE_CHANNEL = 'sulla:usecase:changes';

const TYPES: ReadonlySet<UseCaseType> = new Set(['skill', 'agent', 'workflow', 'function', 'recipe']);
const CHANGES: ReadonlySet<UseCaseChange> = new Set(['published', 'installed', 'updated', 'deleted']);
const MAX_SLUG_LENGTH = 200;

/** Fire-and-forget pub/sub carrier between processes (Redis in Desktop, in-memory in tests). */
export interface UseCaseChangeTransport {
  publish(channel: string, message: string): Promise<void>;
  /** Resolves once subscribed; the returned function unsubscribes. */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
}

/** What every definition writer depends on. `announce` never throws: callers invoke it after commit. */
export interface UseCaseChangePublisher { announce(event: UseCaseChangeEvent): void }

/** The subset of ioredis the transport uses. */
export interface RedisPubSubConnection {
  readonly status: string;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  duplicate(): RedisPubSubConnection;
  disconnect(): void;
}

/**
 * Redis pub/sub over the app's existing Redis client (the same pattern as
 * WorkflowContainerEventBridge). Publishing never opens a connection: a write
 * made while Redis is down is left to the index's fingerprint reconcile.
 */
export class RedisUseCaseChangeTransport implements UseCaseChangeTransport {
  constructor(private readonly redis: { getClient(): RedisPubSubConnection }) {}

  async publish(channel: string, message: string): Promise<void> {
    const client = this.redis.getClient();
    if (client.status !== 'ready') throw new Error(`Redis is ${ client.status }; reconcile will pick the change up`);
    await client.publish(channel, message);
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>> {
    const subscriber = this.redis.getClient().duplicate();
    subscriber.on('message', (from, message) => { if (from === channel) onMessage(message); });
    // ioredis reconnects and re-subscribes on its own; errors only need to stay handled.
    subscriber.on('error', () => undefined);
    await subscriber.subscribe(channel);
    return async() => {
      await subscriber.unsubscribe(channel).catch(() => undefined);
      subscriber.disconnect();
    };
  }
}

interface Envelope { v: 1; origin: string; type: UseCaseType; slug: string; change: UseCaseChange }

/** Validates and (de)serialises change messages. Malformed input is rejected, never forwarded. */
class UseCaseChangeCodec {
  encode(origin: string, event: UseCaseChangeEvent): string {
    const envelope: Envelope = { v: 1, origin, type: event.type, slug: event.slug, change: event.change };
    return JSON.stringify(envelope);
  }

  decode(message: string): Envelope | null {
    let raw: any;
    try { raw = JSON.parse(message); } catch { return null; }
    if (!raw || raw.v !== 1 || typeof raw.origin !== 'string') return null;
    const event = this.valid(raw);
    return event ? { v: 1, origin: raw.origin, ...event } : null;
  }

  valid(event: Partial<UseCaseChangeEvent> | null | undefined): UseCaseChangeEvent | null {
    if (!event || !TYPES.has(event.type as UseCaseType) || !CHANGES.has(event.change as UseCaseChange)) return null;
    if (typeof event.slug !== 'string' || !event.slug || event.slug.length > MAX_SLUG_LENGTH) return null;
    return { type: event.type as UseCaseType, slug: event.slug, change: event.change as UseCaseChange };
  }
}

/**
 * Post-commit announcer for definition writers in any process. It only
 * publishes; it holds no listeners and no catalog state.
 */
export class UseCaseChangeAnnouncer implements UseCaseChangePublisher {
  private readonly codec = new UseCaseChangeCodec();

  constructor(
    private readonly transport: UseCaseChangeTransport,
    private readonly logger: SuggestionLogger = console,
    private readonly origin: string = randomUUID(),
  ) {}

  announce(event: UseCaseChangeEvent): void {
    try {
      const valid = this.codec.valid(event);
      if (!valid) { this.logger.info(`[UseCaseChanges] dropped malformed change ${ JSON.stringify(event) }`); return; }
      this.transport.publish(USE_CASE_CHANGE_CHANNEL, this.codec.encode(this.origin, valid))
        .catch(error => this.logger.info(`[UseCaseChanges] ${ valid.type }:${ valid.slug } not broadcast (${ String(error) })`));
    } catch (error) {
      this.logger.info(`[UseCaseChanges] change not broadcast (${ String(error) })`);
    }
  }
}

/**
 * The index's notifier. Local announcements reach listeners synchronously
 * (even with Redis down) and are broadcast; broadcasts from other
 * announcers (models, tools, other processes) arrive over the transport.
 * Its own broadcasts are ignored on the way back, so nothing is applied twice.
 */
export class UseCaseChangeBus implements UseCaseChangeNotifier, UseCaseChangePublisher {
  private readonly listeners = new Set<(event: UseCaseChangeEvent) => void>();
  private readonly codec = new UseCaseChangeCodec();
  private readonly announcer: UseCaseChangeAnnouncer;
  private unsubscribeTransport?: Promise<(() => Promise<void>) | undefined>;

  constructor(
    private readonly transport: UseCaseChangeTransport,
    private readonly logger: SuggestionLogger = console,
    private readonly origin: string = randomUUID(),
  ) {
    this.announcer = new UseCaseChangeAnnouncer(transport, logger, origin);
  }

  subscribe(listener: (event: UseCaseChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Starts receiving other writers' changes. Never throws; a failed subscribe leaves the reconcile backstop. */
  start(): Promise<void> {
    this.unsubscribeTransport ??= this.transport.subscribe(USE_CASE_CHANGE_CHANNEL, message => this.receive(message)).catch((error) => {
      this.logger.info(`[UseCaseChanges] not subscribed; relying on reconcile (${ String(error) })`);
      this.unsubscribeTransport = undefined;
      return undefined;
    });
    return this.unsubscribeTransport.then(() => undefined);
  }

  async stop(): Promise<void> {
    const pending = this.unsubscribeTransport;
    this.unsubscribeTransport = undefined;
    const unsubscribe = await pending;
    await unsubscribe?.().catch(() => undefined);
  }

  announce(event: UseCaseChangeEvent): void {
    const valid = this.codec.valid(event);
    if (!valid) { this.logger.info(`[UseCaseChanges] dropped malformed change ${ JSON.stringify(event) }`); return; }
    this.deliver(valid);
    this.announcer.announce(valid);
  }

  private receive(message: string): void {
    const envelope = this.codec.decode(message);
    if (!envelope) { this.logger.info('[UseCaseChanges] ignored malformed broadcast'); return; }
    if (envelope.origin === this.origin) return;
    this.deliver({ type: envelope.type, slug: envelope.slug, change: envelope.change });
  }

  private deliver(event: UseCaseChangeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.logger.info(`[UseCaseChanges] change listener failed (${ String(error) })`); }
    }
  }
}
