// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Validates the flat raw-request object before tool defaults or wrappers can alter it. */
export class ClerkRawRequestEnvelope {
  accepts(input: unknown, source: 'tool' | 'proxy'): input is Record<string, unknown> {
    return this.refusal(input, source) === undefined;
  }

  /** Why the envelope is refused, naming the unexpected fields; undefined when it is accepted. */
  refusal(input: unknown, source: 'tool' | 'proxy'): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Clerk raw_request takes one flat JSON object.';
    const fields = this.fields(source);
    const unexpected = Object.keys(input).filter(key => !fields.includes(key));
    if (!unexpected.length) return undefined;
    const named = unexpected.slice(0, 3).map(key => `"${ this.safeName(key) }"`).join(', ');
    const more = unexpected.length > 3 ? ` and ${ unexpected.length - 3 } more` : '';
    return `Clerk raw_request does not accept the field${ unexpected.length > 1 ? 's' : '' } ${ named }${ more }. ` +
      `Allowed top-level fields: ${ fields.join(', ') }. Put Clerk parameters in query or body.`;
  }

  private fields(source: 'tool' | 'proxy'): string[] {
    const fields = ['method', 'path', 'query', 'body', 'confirm', 'environment', 'headers', 'operationId'];
    if (source === 'tool') fields.push('accountId');
    return fields;
  }

  /** Field names are caller text: cap their length and never echo anything shaped like a Clerk key. */
  private safeName(key: string): string {
    if (/(?:sk|pk)_(?:live|test)_/i.test(key)) return '[REDACTED]';
    const printable = key.replace(/[^\x20-\x7e]/g, '?');
    return printable.length > 40 ? `${ printable.slice(0, 40) }…` : printable;
  }
}
