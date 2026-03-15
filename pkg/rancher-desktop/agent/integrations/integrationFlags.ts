// Shared flags for integration lifecycle coordination
// Kept in a separate module to avoid circular imports between index.ts and integration clients

// Flag to suppress the onValueChange listener when connection_status is set by the backend itself
// (e.g., SlackClient._doInitialize sets connection_status=true after successful connect)
let suppressConnectionStatusReload = false;

export function withSuppressedConnectionStatus<T>(fn: () => Promise<T>): Promise<T> {
  suppressConnectionStatusReload = true;
  return fn().finally(() => { suppressConnectionStatusReload = false });
}

export function isConnectionStatusSuppressed(): boolean {
  return suppressConnectionStatusReload;
}
