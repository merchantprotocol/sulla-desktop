// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface BrokerRedirectContext {
  operation: string;
  integrationId?: string;
  requestUrl: URL;
  status: number;
  location?: string;
}

/** Allows exposing (never following) GitHub Actions log redirects to the desktop client. */
export class BrokerRedirectPolicy {
  constructor(private readonly allowedHosts: readonly string[] = [
    'pipelines.actions.githubusercontent.com',
    'results-receiver.actions.githubusercontent.com',
    '*.blob.core.windows.net',
    'pipelines*.actions.githubusercontent.com',
  ]) {}

  allowsGitHubLogRedirect(context: BrokerRedirectContext): boolean {
    if (context.status !== 302 || context.operation !== 'github.api' || context.integrationId !== 'github' ||
        context.requestUrl.hostname !== 'api.github.com' ||
        !/^\/repos\/[^/]+\/[^/]+\/actions\/(?:jobs\/\d+|runs\/\d+(?:\/attempts\/\d+)?)\/logs$/.test(context.requestUrl.pathname) ||
        !context.location) return false;
    let destination: URL;
    try { destination = new URL(context.location); } catch { return false; }
    if (destination.protocol !== 'https:' || destination.username || destination.password) return false;
    return this.allowedHosts.some(pattern => {
      if (pattern.startsWith('*.')) return destination.hostname.endsWith(pattern.slice(1));
      if (!pattern.includes('*')) return destination.hostname === pattern;
      const [prefix, suffix] = pattern.split('*');
      return destination.hostname.startsWith(prefix) && destination.hostname.endsWith(suffix);
    });
  }
}
