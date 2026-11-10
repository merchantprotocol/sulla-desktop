// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalVaultBrokerClient } from '../../../vault-broker';

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;
type LogRequest = Parameters<LocalVaultBrokerClient['executeStream']>[0];

/**
 * Reads a GitHub Actions job log. GitHub answers the log endpoint with a 302 to a
 * pre-signed blob URL; that URL is fetched without GitHub credentials, and only
 * when its host is on the log allow-list.
 */
export class GitHubLogStreamFetcher {
  private readonly redirectHosts: readonly string[] = [
    'pipelines.actions.githubusercontent.com',
    'results-receiver.actions.githubusercontent.com',
    '*.blob.core.windows.net',
    'pipelines*.actions.githubusercontent.com',
  ];

  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async fetchLogStream(
    broker: Pick<LocalVaultBrokerClient, 'executeStream'>,
    request: LogRequest,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const response = await broker.executeStream({ ...request, responseType: 'stream' }, signal);
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('GitHub Actions log redirect did not include a Location header');

    let redirect: URL;
    try {
      redirect = new URL(location);
    } catch {
      throw new Error('GitHub Actions log redirect was not a valid URL');
    }
    if (!this.isAllowedRedirect(redirect)) {
      throw new Error(`GitHub Actions log redirect host is not allow-listed: ${ redirect.hostname }`);
    }

    // The redirect URL is pre-signed. Never forward the GitHub credential to it.
    return this.fetchImpl(redirect, { method: 'GET', redirect: 'error', signal });
  }

  isAllowedRedirect(url: URL): boolean {
    if (url.protocol !== 'https:') return false;
    return this.redirectHosts.some(pattern => {
      if (pattern.startsWith('*.')) return url.hostname.endsWith(pattern.slice(1));
      if (!pattern.includes('*')) return url.hostname === pattern;
      const [prefix, suffix] = pattern.split('*');
      return url.hostname.startsWith(prefix) && url.hostname.endsWith(suffix);
    });
  }
}
