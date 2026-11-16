// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Provider WebSocket destination checks; a failure is always `relay_destination_denied`. */
export class RelayDestinationPolicy {
  static assertProviderWebSocket(value: string, allowedHosts: ReadonlySet<string>): URL {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !allowedHosts.has(url.hostname) || url.username || url.password) {
      throw new Error('relay_destination_denied');
    }
    return url;
  }

  static assertDiscordGateway(value: string): URL {
    const url = new URL(value);
    const providerHost = url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg');
    if (url.protocol !== 'wss:' || !providerHost || url.username || url.password) {
      throw new Error('relay_destination_denied');
    }
    return url;
  }
}
