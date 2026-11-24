// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Sanitizes tool payloads before they cross into the Detailed transcript. */
export class TracePayloadRedactor {
  private readonly secretKey = /(?:secret|token|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)/i;
  private readonly secretTextPatterns: readonly [RegExp, string][] = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
    [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
    [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '[REDACTED]'],
    [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]'],
    [/\bxox[abprse]-[A-Za-z0-9-]{8,}/g, '[REDACTED]'],
    [/((?:["']?(?:token|secret|password|api[_-]?key|access[_-]?token|authorization|cookie)["']?)\s*[:=]\s*)(["']?)([^"'\s,;&}]+)(["']?)/gi, '$1$2[REDACTED]$4'],
    [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  ];

  redact(value: unknown): unknown {
    return this.redactValue(value, new WeakSet<object>());
  }

  redactText(value: string): string {
    return this.secretTextPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  }

  serialize(value: unknown, maxChars = 20_000): string {
    let text: string;
    try {
      const safe = this.redact(value);
      text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2) ?? String(safe);
    } catch {
      text = '[Payload unavailable]';
    }
    const redacted = this.redactText(text);
    return redacted.length <= maxChars
      ? redacted
      : `${ redacted.slice(0, maxChars) }\n\n[truncated ${ redacted.length - maxChars } chars]`;
  }

  private redactValue(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => this.redactValue(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      this.secretKey.test(key) ? '[REDACTED]' : this.redactValue(item, seen),
    ]));
  }
}
