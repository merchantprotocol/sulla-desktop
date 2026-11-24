// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Sanitizes tool payloads before they cross into the Detailed transcript. */
export class TracePayloadRedactor {
  private readonly secretKeys = new Set([
    'access_token', 'refresh_token', 'id_token', 'auth_token', 'token', 'secret', 'api_token', 'x_api_key',
    'aws_secret', 'session_token', 'passwd', 'password', 'credentials', 'bearer', 'api_key', 'private_key',
    'secret_key', 'slack_bot_token', 'authorization', 'cookie', 'set_cookie',
  ]);

  private readonly secretFieldPattern = this.buildSecretFieldPattern();
  private readonly secretTextPatterns: readonly [RegExp, string][] = [
    [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, '[REDACTED PEM]'],
    [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*$/g, '[REDACTED PEM]'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]'],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]'],
    [/\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, '[REDACTED API KEY]'],
    [/\bBearer\s+\S+/gi, 'Bearer [REDACTED]'],
    [/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, '[REDACTED API KEY]'],
    [/\b(?:sk|rk)_live_[A-Za-z0-9]{8,}/g, '[REDACTED LIVE KEY]'],
    [/\bya29\.[A-Za-z0-9._~+/-]{8,}/g, '[REDACTED OAUTH TOKEN]'],
    [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '[REDACTED TOKEN]'],
    [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED TOKEN]'],
    [/\bxox[abprse]-[A-Za-z0-9-]{8,}/g, '[REDACTED TOKEN]'],
    [/^([ \t]*(?:authorization|cookie|set-cookie|x-api-key)[ \t]*:[ \t]*)[^\r\n]*/gim, '$1[REDACTED]'],
    [new RegExp(String.raw`(^|[^\w-])(["']?${ this.secretFieldPattern }["']?\s*[:=]\s*)(["'])(?:\\.|(?!\3)[^\\])*\3`, 'gi'), '$1$2$3[REDACTED]$3'],
    [new RegExp(String.raw`(^|[^\w-])(["']?${ this.secretFieldPattern }["']?\s*[:=]\s*)([^"'\s,;&}]+)`, 'gi'), '$1$2[REDACTED]'],
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
    return text.length <= maxChars
      ? text
      : `${ text.slice(0, maxChars) }\n\n[truncated ${ text.length - maxChars } chars]`;
  }

  private buildSecretFieldPattern(): string {
    const separated = (field: string) => field.split('_').map(part => this.escapeRegExp(part)).join('[_\\s.-]*');
    const explicit = [...this.secretKeys].map(separated).join('|');
    // Catch named secret fields such as clientSecret without matching arbitrary
    // fields containing "token" (max_tokens/prompt_tokens remain ordinary data).
    return `(?:${ explicit }|[a-z0-9]+[_\\s.-]*secret)`;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeKey(value: string): string {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private isSecretKey(key: string): boolean {
    const normalized = this.normalizeKey(key);
    return this.secretKeys.has(normalized) || /(?:^|_)secret$/.test(normalized);
  }

  private redactValue(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const safe = Array.isArray(value) ? value.map(item => this.redactValue(item, seen)) :
      Object.fromEntries(Object.entries(value).map(([key, item]) => [
        this.redactText(key),
        this.isSecretKey(key) ? '[REDACTED]' : this.redactValue(item, seen),
      ]));
    seen.delete(value);
    return safe;
  }
}
