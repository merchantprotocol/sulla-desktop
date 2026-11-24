// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Fail-closed sanitizer for every string rendered by the detailed trace. */
export class TracePayloadRedactor {
  static readonly withheld = 'Details withheld';
  private readonly denylist = /(?:^|[\/_:. -])(vault|secrets?|credentials?|passwords?|wallet|crypto|keychain|auth|token)(?:$|[\/_:. -])/i;
  private readonly patterns: readonly [RegExp, string][] = [
    [/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
    [/\bBearer\s+\S+/gi, 'Bearer [REDACTED]'],
    [/\bxox[a-z]-[A-Za-z0-9-]+/gi, '[REDACTED SLACK TOKEN]'],
    [/\bslack_bot_token\s*[:=]\s*\S+/gi, 'slack_bot_token=[REDACTED]'],
    [/\b(?:sk-|ghp_|gho_|github_pat_|AKIA|ASIA|AIza)[A-Za-z0-9_\-/]{8,}/g, '[REDACTED API KEY]'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]'],
    [/(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/gi, '[REDACTED CONNECTION]://'],
    [/(^|\s)(?:-p|--password(?:=|\s+)|password\s*[:=]|passwd\s*[:=])[^\s,;&}]+/gi, '$1password=[REDACTED]'],
    [/(^|[^\w-])((?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|secret|private[_ -]?key|authorization|cookie))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1$2=[REDACTED]'],
  ];

  isDenied(toolName: string | undefined): boolean {
    return !!toolName && this.denylist.test(toolName);
  }

  redactText(value: string, toolName?: string): string {
    if (this.isDenied(toolName)) return TracePayloadRedactor.withheld;
    return this.patterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  }

  redact(value: unknown, toolName?: string): unknown {
    if (this.isDenied(toolName)) return TracePayloadRedactor.withheld;
    if (typeof value === 'string') return this.redactText(value, toolName);
    if (Array.isArray(value)) return value.map(item => this.redact(item, toolName));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      this.redactText(key), /(?:secret|token|password|credential|private.?key|api.?key|authorization|cookie)/i.test(key)
        ? TracePayloadRedactor.withheld : this.redact(item, toolName),
    ]));
  }

  serialize(value: unknown, toolName?: string, maxChars = 20_000): string {
    const safe = this.redact(value, toolName);
    let text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2) ?? String(safe);
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}… truncated`;
    return text;
  }
}
