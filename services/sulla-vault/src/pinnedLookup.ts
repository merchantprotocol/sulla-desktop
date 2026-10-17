import type { LookupFunction } from 'node:net';

/** Node 24 requests all addresses for connection-family autoselection. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}
