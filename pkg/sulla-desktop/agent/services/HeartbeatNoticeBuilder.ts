// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CHAT_HEARTBEAT_MAX_DURATION_MS, type ChatHeartbeatSetBy } from '@pkg/shared/chatHeartbeat';

export interface HeartbeatNoticeInput {
  intervalMinutes: number;
  startedAt: number;
  expiresAt: number;
  setBy?: ChatHeartbeatSetBy;
  pendingWait?: boolean;
  autoOff?: boolean;
}

export interface HeartbeatMessageInput extends HeartbeatNoticeInput {
  message: string;
}

/** Builds the agent-facing heartbeat explanation in the user's local timezone. */
export class HeartbeatNoticeBuilder {
  private readonly dateTime: Intl.DateTimeFormat;

  constructor(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    this.dateTime = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone, timeZoneName: 'short',
    });
  }

  buildMessage(input: HeartbeatMessageInput): string {
    return `${ input.message }\n\n${ this.buildNotice(input) }`;
  }

  buildNotice(input: HeartbeatNoticeInput): string {
    const interval = `${ input.intervalMinutes } ${ input.intervalMinutes === 1 ? 'minute' : 'minutes' }`;
    const setter = this.setterLabel(input.setBy ?? 'human');
    const lines = [
      '--- HEARTBEAT NOTICE ---',
      `Heartbeat notice: This message was sent automatically by your heartbeat, not typed just now by your manager. It fires every ${ interval }; it was set at ${ this.formatLocalTime(input.startedAt) } by ${ setter } and switches itself off at ${ this.formatLocalTime(input.expiresAt) }.`,
      'Use it to check on your work and move it forward.',
      `Turn it off as soon as the work it watches is finished: sulla chat/set_heartbeat '{"intervalMinutes":0}'.`,
    ];
    if (input.pendingWait) lines.push('Your agents/wait timer is still pending and will still wake you.');
    if (input.autoOff) {
      const hours = CHAT_HEARTBEAT_MAX_DURATION_MS / 3_600_000;
      lines.push(`System: your heartbeat was switched off automatically after ${ hours } hours. If the work it was watching is still open, turn it back on with sulla chat/set_heartbeat '{"intervalMinutes":${ input.intervalMinutes },"message":"..."}'.`);
    }
    return lines.join('\n');
  }

  private formatLocalTime(timestamp: number): string {
    return this.dateTime.format(new Date(timestamp));
  }

  private setterLabel(setBy: ChatHeartbeatSetBy): string {
    if (setBy === 'agent') return 'you';
    if (setBy === 'manager') return 'your manager';
    return 'the human';
  }
}
