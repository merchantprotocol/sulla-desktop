// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailAddress } from './AgentMailAddress';
import { AgentMailError } from './AgentMailError';
import { AgentMailUntrustedContent, type AgentMailMessageSummary } from './AgentMailUntrustedContent';

import type { AgentMailTransport } from './AgentMailTransport';

export interface AgentMailClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** One server long-poll answer from a wait-for-code endpoint. */
export interface AgentMailCodePoll {
  code?:       string | null;
  candidates?: string[];
  timedOut?:   boolean;
  message?:    AgentMailMessageSummary;
}

class SystemAgentMailClock implements AgentMailClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Shared rules for both agent mail APIs (the service /agent-mail lane and
 * the user /agent-mailboxes lane): input validation, the wait-for-code
 * long-poll loop and its clamp, and the untrusted-content envelope.
 */
export abstract class AgentMailApiClient {
  static readonly DEFAULT_WAIT_SECONDS = 120;
  static readonly MAX_WAIT_SECONDS = 300;
  /** The server holds one long-poll for at most 30 s. */
  static readonly SERVER_POLL_SECONDS = 30;
  /** wait_for_code with no `since` also accepts mail that landed just before the call. */
  static readonly DEFAULT_LOOKBACK_MS = 120_000;
  static readonly MAX_LIST_LIMIT = 100;
  private static readonly MIN_POLL_GAP_MS = 1_000;
  private static readonly ID = /^[A-Za-z0-9._~-]{1,200}$/;

  constructor(
    protected readonly transport: AgentMailTransport,
    protected readonly addresses = new AgentMailAddress(),
    protected readonly content = new AgentMailUntrustedContent(),
    protected readonly clock: AgentMailClock = new SystemAgentMailClock(),
  ) {}

  /** Clamp a caller timeout (seconds) to 1..300, default 120. */
  static waitSeconds(raw: unknown): number {
    const value = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) return AgentMailApiClient.DEFAULT_WAIT_SECONDS;
    return Math.min(AgentMailApiClient.MAX_WAIT_SECONDS, Math.max(1, Math.round(value)));
  }

  /**
   * Repeat a ≤30 s server long-poll until a code arrives or the caller's
   * timeout (default 120 s, max 300 s) runs out.
   */
  protected async pollForCode(input: { since?: unknown; timeout?: unknown }, once: (since: string, pollSeconds: number) => Promise<AgentMailCodePoll>) {
    const timeoutSeconds = AgentMailApiClient.waitSeconds(input.timeout);
    const started = this.clock.now();
    const deadline = started + timeoutSeconds * 1000;
    const since = this.since(input.since) ?? String(Math.max(0, started - AgentMailApiClient.DEFAULT_LOOKBACK_MS));
    for (;;) {
      const remainingMs = deadline - this.clock.now();
      if (remainingMs <= 0) break;
      const pollSeconds = Math.min(AgentMailApiClient.SERVER_POLL_SECONDS, Math.ceil(remainingMs / 1000));
      const pollStarted = this.clock.now();
      const body = await once(since, pollSeconds);
      if (body?.code) {
        return this.content.envelope({
          code:          String(body.code),
          candidates:    Array.isArray(body.candidates) ? body.candidates.map(String) : [String(body.code)],
          timedOut:      false,
          waitedSeconds: Math.round((this.clock.now() - started) / 1000),
          message:       body.message ? this.content.summary(body.message) : null,
        });
      }
      const elapsed = this.clock.now() - pollStarted;
      if (elapsed < AgentMailApiClient.MIN_POLL_GAP_MS && deadline - this.clock.now() > 0) {
        await this.clock.sleep(AgentMailApiClient.MIN_POLL_GAP_MS - elapsed);
      }
    }
    return this.content.envelope({ code: null, candidates: [], timedOut: true, waitedSeconds: timeoutSeconds, message: null });
  }

  /** The validated subject and body of an outgoing message. */
  protected outgoing(input: { to: unknown; subject: unknown; text?: unknown; html?: unknown }) {
    const to = this.addresses.recipient(input.to);
    const subject = String(input.subject ?? '').trim();
    if (!subject || /[\r\n]/.test(subject)) throw new AgentMailError('invalid_input', 'subject is required and must be one line');
    const text = typeof input.text === 'string' && input.text ? input.text : undefined;
    const html = typeof input.html === 'string' && input.html ? input.html : undefined;
    if (!text && !html) throw new AgentMailError('invalid_input', 'text or html body is required');
    return { to, subject, ...(text ? { text } : {}), ...(html ? { html } : {}) };
  }

  protected limit(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    return String(Math.min(AgentMailApiClient.MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(raw) || 1))));
  }

  protected id(raw: unknown, field = 'id', hint = 'a message id from mail/list'): string {
    const id = String(raw ?? '').trim();
    if (!AgentMailApiClient.ID.test(id)) throw new AgentMailError('invalid_input', `${ field } must be ${ hint }`);
    return id;
  }

  /** ISO date or epoch milliseconds → epoch-ms string; undefined when absent. */
  protected since(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const text = String(raw).trim();
    const value = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
    if (!Number.isFinite(value) || value < 0) throw new AgentMailError('invalid_input', 'since must be an ISO date or epoch milliseconds');
    return String(value);
  }
}
