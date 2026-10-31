// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * One timeline of everything first run does, in first-run.log, so a single
 * file explains a failed setup end to end: wizard steps, Cloud sign-in, vault
 * creation and unlock, sign-ins held in memory and flushed, provider OAuth,
 * model selection, services and the first chat.
 *
 * Never pass secrets on purpose. Values are still scrubbed: secret-looking
 * keys are dropped and token-shaped strings are masked before writing.
 */

import Logging from '@pkg/utils/logging';

const log = Logging['first-run'];

const SECRET_KEY = /token|secret|password|passphrase|masterkey|master_key|authhash|cookie|credential|api_?key|oauth_code|^code$/i;
const SECRET_VALUE = [
  /sk-ant-[A-Za-z0-9_-]+/g, // Anthropic keys and OAuth tokens
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /xai-[A-Za-z0-9_-]{20,}/g, // xAI keys
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWTs
  /\b(?:code|state|token|access_token|refresh_token)=[^&\s"']+/gi, // OAuth query parameters
  /\b[A-Za-z0-9_-]{48,}\b/g, // any other long opaque string
];

export function scrubText(text: string): string {
  return SECRET_VALUE.reduce((out, pattern) => out.replace(pattern, (match) => {
    const eq = match.indexOf('=');
    return eq > 0 && eq < 20 ? `${ match.slice(0, eq + 1) }[redacted]` : '[redacted]';
  }), text);
}

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value).slice(0, 2_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return scrubText(value.message).slice(0, 2_000);
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => scrub(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? (item ? '[set]' : '[empty]') : scrub(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Record one first-run event. `area` is the part of the system (wizard,
 * account, vault, pending, claude, oauth, models, services, chat); `event` is
 * a short past-tense or present-tense phrase.
 */
export function firstRunTrace(area: string, event: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details && Object.keys(details).length ? ` ${ JSON.stringify(scrub(details)) }` : '';
    log.log(`[${ area }] ${ scrubText(event) }${ suffix }`);
  } catch {
    // Tracing must never break first run.
  }
}

let ipcInstalled = false;

/** Let the first-run window add its own steps and clicks to the same timeline. */
export function initFirstRunTraceEvents(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  void import('@pkg/main/ipcMain').then(({ getIpcMainProxy }) => {
    getIpcMainProxy(log).on('first-run:trace', (_event, area, event, details) => {
      firstRunTrace(`ui:${ String(area ?? 'wizard').slice(0, 40) }`, String(event ?? '').slice(0, 200),
        details && typeof details === 'object' ? details as Record<string, unknown> : undefined);
    });
  }).catch(() => { /* tracing is best-effort */ });
}
