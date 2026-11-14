// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Produces a small, credential-safe diagnostic excerpt from Git's curl trace. */
export class GitTraceSummary {
  static redactCredentials(trace: string, brokerUrl?: string): string {
    let safe = trace;
    if (brokerUrl) safe = safe.split(brokerUrl).join('[broker URL redacted]');
    safe = safe
      .replace(/(https?:\/\/host\.sulla\.internal:\d+\/)[^/\s'"?#]+/gi, '$1[broker-token]')
      .replace(/((?:authorization|proxy-authorization|cookie|set-cookie|www-authenticate)\s*:\s*)[^\r\n]*/gi, '$1[redacted]')
      .replace(/(\b(?:password|token|access_token)=)[^&\s]+/gi, '$1[redacted]');
    return safe;
  }

  static redact(trace: string, brokerUrl?: string): string {
    const safe = this.redactCredentials(trace, brokerUrl);
    const relevant = safe.split(/\r?\n/).filter(line =>
      /(?:HTTP\/[0-9.]+|HTTP\/2|(?:^|\s)[<>] (?:HTTP\/|(?:content-type|content-length|content-encoding|server|date|transfer-encoding|accept-ranges|etag):)|(?:Info|Trace):.*(?:connected|connect|SSL|TLS|time|bytes|recv|receive|send|upload|download|server|HTTP))/i.test(line),
    );
    return relevant.slice(-80).join('\n').slice(0, 12_000);
  }
}
