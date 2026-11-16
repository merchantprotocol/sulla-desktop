// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Wire contract shared by the local Desktop vault service and trusted callers.
 * Local-mode responses never contain credential plaintext, wrapped item keys,
 * user keys, private keys, master material, or refresh tokens.
 */
export * from './contracts/LocalVaultStatusContracts.js';
export * from './contracts/BootstrapContracts.js';
export * from './contracts/HumanSessionContracts.js';
export * from './contracts/BrokerContracts.js';
export * from './contracts/VaultLifecycleContracts.js';
