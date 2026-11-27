// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const SECRET = /^sk_(test|live)_[A-Za-z0-9_-]+$/;
const PUBLISHABLE = /^pk_(test|live)_([A-Za-z0-9+/_=-]+)$/;

export type ClerkKeyKind = 'test' | 'live';

export interface ClerkKeyPair {
  kind:       ClerkKeyKind;
  frontendHost: string;
}

/**
 * Checks one section's key pair before anything is sent to Clerk. Each problem names the field and
 * what is wrong with it; messages never contain any part of a key beyond its public prefix.
 */
export class ClerkKeyFormat {
  /** Returns the parsed pair, or the first problem as a message for the section label. */
  check(label: string, publishable: string, secret: string): ClerkKeyPair | { problem: string } {
    const problem = (text: string) => ({ problem: `${ label }: ${ text }` });
    if (!publishable) return problem('the publishable key is empty. Enter both keys for this section, or clear both to leave it unset.');
    if (!secret) return problem('the secret key is empty. Enter both keys for this section, or clear both to leave it unset.');
    if (/^sk_/i.test(publishable)) return problem('the publishable key field contains a secret key (sk_…). Paste the key that starts with pk_test_ or pk_live_.');
    if (/^pk_/i.test(secret)) return problem('the secret key field contains a publishable key (pk_…). Paste the key that starts with sk_test_ or sk_live_.');
    if (!/^pk_(?:test|live)_/.test(publishable)) return problem('the publishable key must start with pk_test_ or pk_live_.');
    if (!/^sk_(?:test|live)_/.test(secret)) return problem('the secret key must start with sk_test_ or sk_live_.');
    if (/\s/.test(publishable)) return problem('the publishable key contains spaces or line breaks. Copy it again from the Clerk dashboard.');
    if (/\s/.test(secret)) return problem('the secret key contains spaces or line breaks. Copy it again from the Clerk dashboard.');
    const pk = PUBLISHABLE.exec(publishable);
    const host = pk ? this.decodedHost(pk[2]) : undefined;
    if (!pk || !host) return problem('the publishable key is malformed (it does not decode to a Clerk frontend address). Copy it again from the Clerk dashboard.');
    const sk = SECRET.exec(secret);
    if (!sk) return problem('the secret key is malformed (it has unexpected characters). Copy it again from the Clerk dashboard.');
    if (pk[1] !== sk[1]) {
      return problem(`the publishable key is pk_${ pk[1] }_ but the secret key is sk_${ sk[1] }_. Both keys must come from the same Clerk instance.`);
    }
    return { kind: sk[1] as ClerkKeyKind, frontendHost: host };
  }

  /** The hostname of a Clerk frontend URL, or undefined when it is not a bare https host. */
  frontendHost(input: string): string | undefined {
    try {
      const url = new URL(input.includes('://') ? input : `https://${ input }`);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
          url.pathname === '/' && !url.search && !url.hash && /^[a-z0-9.-]+$/i.test(url.hostname)) return url.hostname;
    } catch { /* malformed Clerk frontend hostname */ }
    return undefined;
  }

  private decodedHost(encoded: string): string | undefined {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return decoded.endsWith('$') ? this.frontendHost(decoded.slice(0, -1)) : undefined;
  }
}
