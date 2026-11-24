// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Fail-closed sanitizer for every string rendered by the detailed trace. */
export class TracePayloadRedactor {
  static readonly withheld = 'Details withheld';
  private readonly denylist = /(?:^|[\/_:. -])(vault|secrets?|credentials?|passwords?|wallet|crypto|keychain|auth|token)(?:$|[\/_:. -])/i;
  private readonly sensitiveAssignment = /(^|[^A-Za-z0-9_])(?:[A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH|SESSION|COOKIE|DSN|CONNECTION)[A-Za-z0-9_]*)[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;&}]+)/gi;
  /** Command readers are deliberately independent of the tool adapter name. */
  private readonly sensitiveReader = /(?:^|[\s\"'([{;&|])(?:cat|less|more|head|tail|bat|grep|rg|awk|sed|source|xxd|base64|cp|scp|\.)\b[^\n;&|]{0,500}/i;
  private readonly sensitivePath = /(?:^|[\s\"'([{=:])(?:(?:~|[A-Za-z0-9_.-]+)\/)*(?:\.env(?:[._-][A-Za-z0-9_-]+)?|\.aws\/credentials|\.ssh\/[A-Za-z0-9_.-]+|id_(?:rsa|ed25519)(?:[._-][A-Za-z0-9_-]+)?|[A-Za-z0-9_.-]+\.(?:pem|key|p12)|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.docker\/config\.json|kubeconfig)(?=$|[\s\"',;)}\]\.:])/i;
  private readonly sensitiveBuiltin = /(?:^|[\s\"'([{;&|])(?:env|printenv|set)(?=\s|$)|(?:^|[\s\"'([{;&|])export\s+-p(?:\s|$)|(?:^|[\s\"'([{;&|])docker\s+inspect\b|(?:^|[\s\"'([{;&|])kubectl\s+get\s+secret\b|(?:^|[\s\"'([{;&|])security\s+find-generic-password\b|(?:^|[\s\"'([{;&|])op\s+read\b|(?:^|[\s\"'([{;&|])gh\s+auth\s+token\b|(?:^|[\s\"'([{;&|])aws\s+configure\s+get\b|(?:^|[\s\"'([{;&|])gcloud\s+auth\s+print-access-token\b/i;
  private readonly patterns: readonly [RegExp, string][] = [
    [/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
    [/\bBearer\s+\S+/gi, 'Bearer [REDACTED]'],
    [/\bxox[a-z]-[A-Za-z0-9-]+/gi, '[REDACTED SLACK TOKEN]'],
    [/\bslack_bot_token\s*[:=]\s*\S+/gi, 'slack_bot_token=[REDACTED]'],
    [/\b(?:sk-|ghp_|gho_|github_pat_|AKIA|ASIA|AIza)[A-Za-z0-9_\-/]{8,}/g, '[REDACTED API KEY]'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]'],
    [/(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/gi, '[REDACTED CONNECTION]://'],
    [/(^|\s)(?:-p|--(?:password|api[-_]?key|token|secret)(?:=|\s+)|password\s*[:=]|passwd\s*[:=])[^\s,;&}]+/gi, '$1password=[REDACTED]'],
    [/(^|[^\w-])((?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|secret|private[_ -]?key|authorization|cookie))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1$2=[REDACTED]'],
    [/(\?|&|;)\s*(?:password|token|key|sig)\s*=\s*(?:"[^"]*"|'[^']*'|[^&;\s]+)/gi, '$1[REDACTED]=[REDACTED]'],
  ];

  isDenied(toolName: string | undefined): boolean {
    return !!toolName && this.denylist.test(toolName);
  }

  isSensitiveCommand(value: unknown, _toolName?: string): boolean {
    const command = this.commandText(value);
    if (this.sensitiveBuiltin.test(command)) return true;
    return this.sensitiveReader.test(command) && this.sensitivePath.test(command);
  }

  private commandText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    try { return JSON.stringify(value) ?? ''; } catch { return ''; }
  }

  redactText(value: string, toolName?: string): string {
    if (this.isDenied(toolName)) return TracePayloadRedactor.withheld;
    const assignmentsRedacted = value.replace(this.sensitiveAssignment, '$1[REDACTED]=[REDACTED]');
    return this.patterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), assignmentsRedacted);
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
