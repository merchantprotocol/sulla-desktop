// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Only the guest preload script builder is used from the main process (to
// inject `window.sullaBridge` into each tab). The host-side bridge,
// registry, and IPC plumbing were removed in favour of main-process
// TabRegistry + GuestBridge. See pkg/sulla-desktop/main/browserTabs/.
export { buildGuestBridgeScript, BRIDGE_CHANNEL, GLOBAL_NAME } from './GuestBridgePreload';
