// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// OAuth provider registry — map-based lookup by provider ID.

import type { OAuthProvider } from './OAuthProvider';

const providers = new Map<string, OAuthProvider>();

export function registerOAuthProvider(provider: OAuthProvider): void {
  providers.set(provider.config.id, provider);
}

export function getOAuthProvider(id: string): OAuthProvider | undefined {
  return providers.get(id);
}

export function getAllOAuthProviders(): OAuthProvider[] {
  return Array.from(providers.values());
}
