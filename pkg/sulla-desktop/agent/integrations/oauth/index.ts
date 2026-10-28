// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Barrel: re-exports types + registry, auto-registers all providers.

// Auto-register concrete providers on import
import './providers/CloudflareOAuth';
import './providers/CodexOAuth';
import './providers/GoogleOAuth';
import './providers/GrokOAuth';
import './providers/IntuitOAuth';
import './providers/OpenAIOAuth';
import './providers/RobinhoodOAuth';

export { OAuthProvider, type OAuthProviderConfig, type OAuthTokenSet } from './OAuthProvider';
export { registerOAuthProvider, getOAuthProvider, getAllOAuthProviders } from './registry';
