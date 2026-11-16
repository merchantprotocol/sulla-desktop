// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Vault-held provider relays (Slack socket mode, Discord gateway, enterprise
// gateway, Sulla Cloud). The implementation lives in ./relays/; this module
// keeps the original import path and export names for existing callers.
import { RelayIdGenerator } from './relays/RelayIdGenerator.js';

export type {
  SullaCloudSocketFactory, VaultRelayEvent, VaultRelayHandle, VaultRelayManager, VaultRelayOpenRequest, VaultRelayOperation,
} from './relays/RelayContracts.js';
export { DefaultVaultRelayManager } from './relays/DefaultVaultRelayManager.js';

/** @deprecated use RelayIdGenerator — E9 alias, removed in final cleanup */
export function createRelayId(): string {
  return new RelayIdGenerator().next();
}
