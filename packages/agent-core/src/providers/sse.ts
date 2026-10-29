// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Server-sent events parser for streamed provider replies. Chunks can split
 * anywhere (mid-line, mid-`\r\n`); events come out whole.
 */

export interface SseEvent {
  event?: string;
  data:   string;
}

export interface SseParser {
  push(chunk: string): void;
  /** Flush a final event that had no trailing blank line. */
  end(): void;
}

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = '';
  let eventName: string | undefined;
  let data: string[] = [];

  const dispatch = () => {
    if (data.length) {
      const ev: SseEvent = { data: data.join('\n') };
      if (eventName) ev.event = eventName;
      onEvent(ev);
    }
    eventName = undefined;
    data = [];
  };

  const line = (l: string) => {
    if (l === '') return dispatch();
    if (l.charAt(0) === ':') return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.charAt(0) === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') eventName = value;
  };

  const drain = (final: boolean) => {
    for (;;) {
      const nl = buffer.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      // A lone `\r` at the end may be the first half of `\r\n`.
      if (!final && buffer.charAt(nl) === '\r' && nl === buffer.length - 1) break;
      const width = buffer.charAt(nl) === '\r' && buffer.charAt(nl + 1) === '\n' ? 2 : 1;
      line(buffer.slice(0, nl));
      buffer = buffer.slice(nl + width);
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      drain(false);
    },
    end() {
      drain(true);
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    },
  };
}
