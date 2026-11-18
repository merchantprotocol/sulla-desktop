// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Renderer transcript budget. Deliberately shared by all in-memory chat layers. */
export class MessageWindow {
  static readonly MAX_TURNS = 50;
  static readonly MAX_PAYLOAD_UNITS = 2_000_000;

  /** Keep the newest contiguous suffix bounded by turns and UTF-16 payload size. */
  trim<T extends Record<string, any>>(messages: readonly T[]): T[] {
    if (messages.length === 0) return [];
    let start = 0;
    let turns = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (this.isUser(messages[i])) {
        turns++;
        if (turns > MessageWindow.MAX_TURNS) { start = i + 1; break; }
      }
    }
    let units = 0;
    for (let i = messages.length - 1; i >= start; i--) {
      units += this.payloadUnits(messages[i]);
      if (units > MessageWindow.MAX_PAYLOAD_UNITS && i < messages.length - 1) { start = i + 1; break; }
    }
    return messages.slice(start);
  }

  private isUser(message: Record<string, any>): boolean {
    return message.role === 'user' || message.kind === 'user';
  }

  private payloadUnits(message: Record<string, any>): number {
    let units = 0;
    for (const [key, value] of Object.entries(message)) {
      if (typeof value === 'string') units += key.length + value.length;
      else if (value && typeof value === 'object') units += JSON.stringify(value).length;
    }
    return units;
  }
}
