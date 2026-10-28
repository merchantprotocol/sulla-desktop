// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const MAX_NATIVE_SOURCE_BYTES = 64 * 1024 * 1024;

export async function readBoundedResponse(response:Response, limit = MAX_NATIVE_SOURCE_BYTES):Promise<Buffer> {
  const lengthHeader = response.headers.get('content-length');
  const declared = lengthHeader === null ? undefined : Number(lengthHeader);

  if (!response.ok) throw new Error(`Files content request failed (${ response.status })`);
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > limit)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Files content exceeds the native source size bound');
  }
  if (!response.body) {
    if (declared !== undefined && declared !== 0) throw new Error('Files content length changed during native publication');
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks:Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('Files content exceeds the native source size bound');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (declared !== undefined && declared !== total) {
    await reader.cancel().catch(() => undefined);
    throw new Error('Files content length changed during native publication');
  }

  return Buffer.concat(chunks, total);
}
