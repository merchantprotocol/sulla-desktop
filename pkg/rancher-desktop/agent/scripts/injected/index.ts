// Only the guest preload script builder is used from the main process (to
// inject `window.sullaBridge` into each tab). The host-side bridge,
// registry, and IPC plumbing were removed in favour of main-process
// TabRegistry + GuestBridge. See pkg/rancher-desktop/main/browserTabs/.
export { buildGuestBridgeScript, BRIDGE_CHANNEL, GLOBAL_NAME } from './GuestBridgePreload';
