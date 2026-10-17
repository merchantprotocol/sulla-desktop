import { createHash } from 'node:crypto';

import { bootstrapUnlockProofInput } from './contracts.js';

/**
 * Bind the unlock proof to the exact base64url text sent on the wire.
 * The authority hashes request.sealedUnlock before decoding it, so callers
 * must not hash the decoded envelope bytes.
 */
export function bootstrapUnlockProofInputForSealed(
  callerId: string,
  clientNonce: string,
  serverNonce: string,
  challengeId: string,
  expiresAt: number,
  sealedUnlock: string,
): string {
  const sealedSha256 = createHash('sha256').update(sealedUnlock, 'utf8').digest('base64url');

  return bootstrapUnlockProofInput(
    callerId,
    clientNonce,
    serverNonce,
    challengeId,
    expiresAt,
    sealedSha256,
  );
}
