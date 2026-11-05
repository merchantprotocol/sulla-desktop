// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export class AgentWaitRequest {
  static readonly MIN_SECONDS = 10;
  static readonly MAX_SECONDS = 4 * 60 * 60;

  private constructor(readonly seconds: number, readonly reason: string, readonly wakeAt: Date) {}

  static create(seconds: unknown, reason: unknown, now = new Date()): AgentWaitRequest {
    const duration = Number(seconds);
    const explanation = String(reason ?? '').trim();
    if (!Number.isInteger(duration) || duration < this.MIN_SECONDS || duration > this.MAX_SECONDS) {
      throw new Error(`seconds must be an integer between ${ this.MIN_SECONDS } and ${ this.MAX_SECONDS }.`);
    }
    if (!explanation) throw new Error('reason must be non-empty.');
    return new AgentWaitRequest(duration, explanation, new Date(now.getTime() + duration * 1000));
  }
}
