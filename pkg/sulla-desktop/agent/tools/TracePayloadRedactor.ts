// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Sanitizes tool payloads before they cross into the Detailed transcript. */
export class TracePayloadRedactor {
  private readonly secretField = '(?:access_token|refresh_token|id_token|auth_token|[a-z0-9_]+_secret|password|api_key|private_key|authorization|cookie|set-cookie)';
  private readonly secretKey = new RegExp(`^${ this.secretField }$`, 'i');
  private readonly secretTextPatterns: readonly [RegExp, string][] = [
    [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, '[REDACTED]'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]'],
    [/\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, '[REDACTED]'],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
    [/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
    [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '[REDACTED]'],
    [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]'],
    [/\bxox[abprse]-[A-Za-z0-9-]{8,}/g, '[REDACTED]'],
    [/^([ \t]*(?:authorization|cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]*/gim, '$1[REDACTED]'],
    [new RegExp(String.raw`(^|[^\w-])(["']?${ this.secretField }["']?\s*[:=]\s*)(["'])(?:\\.|(?!\3)[^\\])*\3`, 'gi'), '$1$2$3[REDACTED]$3'],
    [new RegExp(String.raw`(^|[^\w-])(["']?${ this.secretField }["']?\s*[:=]\s*)([^"'\s,;&}]+)`, 'gi'), '$1$2[REDACTED]'],
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
    const redacted = text;
    return redacted.length <= maxChars
      ? redacted
      : `${ redacted.slice(0, maxChars) }\n\n[truncated ${ redacted.length - maxChars } chars]`;
  }

  private redactValue(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const safe = Array.isArray(value) ? value.map(item => this.redactValue(item, seen)) :
      Object.fromEntries(Object.entries(value).map(([key, item]) => [
        this.redactText(key),
        this.secretKey.test(key) ? '[REDACTED]' : this.redactValue(item, seen),
      ]));
    seen.delete(value);
    return safe;
  }
}
