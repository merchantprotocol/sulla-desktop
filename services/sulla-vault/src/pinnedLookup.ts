// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LookupFunction } from 'node:net';

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/** Node 24 requests all addresses for connection-family autoselection. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** Preserve every validated DNS answer so Node can fail over between public addresses. */
export function pinnedAddressesLookup(addresses: readonly PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = typeof options === 'object' && (options.family === 4 || options.family === 6) ? options.family : 0;
    const eligible = family ? addresses.filter(candidate => candidate.family === family) : addresses;
    const selected = eligible.length ? eligible : addresses;
    if (typeof options === 'object' && options.all) callback(null, [...selected]);
    else if (selected[0]) callback(null, selected[0].address, selected[0].family);
    else callback(new Error('No validated addresses are available'), '', 4);
  };
}
