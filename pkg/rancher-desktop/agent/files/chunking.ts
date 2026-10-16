const MIN = 256 * 1024;
const AVG = 1024 * 1024;
const MAX = 4 * 1024 * 1024;

function gearTable(): bigint[] {
  let state = 0x9e3779b9;
  return Array.from({ length: 256 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return BigInt(state >>> 0);
  });
}

const GEAR = gearTable();
const MASK_SMALL = BigInt((AVG * 2) - 1);
const MASK_LARGE = BigInt((AVG / 2) - 1);

/** FastCDC-style normalized content-defined chunking. */
export function fastCdc(data: Uint8Array): Uint8Array[] {
  if (data.byteLength <= MIN) return [data];
  const chunks: Uint8Array[] = [];
  let start = 0;
  while (start < data.byteLength) {
    const end = Math.min(start + MAX, data.byteLength);
    if (end - start <= MIN) {
      chunks.push(data.subarray(start, end));
      break;
    }
    let hash = 0n;
    let cursor = start + MIN;
    const normal = Math.min(start + AVG, end);
    for (; cursor < normal; cursor++) {
      hash = ((hash << 1n) + GEAR[data[cursor]]) & 0xffffffffffffffffn;
      if ((hash & MASK_SMALL) === 0n) break;
    }
    for (; cursor < end; cursor++) {
      hash = ((hash << 1n) + GEAR[data[cursor]]) & 0xffffffffffffffffn;
      if ((hash & MASK_LARGE) === 0n) break;
    }
    const cut = Math.min(cursor + 1, end);
    chunks.push(data.subarray(start, cut));
    start = cut;
  }
  return chunks;
}
