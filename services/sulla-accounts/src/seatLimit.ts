// SPDX-License-Identifier: LicenseRef-Sulla-Fair-Code
export function seatLimitReached(activeAndPending: number, limit: number, replacingPending = false): boolean {
  return activeAndPending - (replacingPending ? 1 : 0) >= limit;
}
