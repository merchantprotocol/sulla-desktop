import { createHash } from 'node:crypto';
export const FILES_BOOTSTRAP_VERSION = 1;
export const FILES_BOOTSTRAP_DESTINATION = 'sulla-files';
const prefix = 'sulla:files-bootstrap:v1';
export function filesChallengeProofInput(callerId, clientNonce, hasMasterBlob) {
    return `${prefix}:challenge:${FILES_BOOTSTRAP_DESTINATION}:${callerId}:${clientNonce}:${hasMasterBlob ? '1' : '0'}`;
}
export function filesServerProofInput(callerId, clientNonce, serverNonce, challengeId, expiresAt, disposition, hasMasterBlob) {
    return `${prefix}:server:${FILES_BOOTSTRAP_DESTINATION}:${callerId}:${clientNonce}:${serverNonce}:${challengeId}:${expiresAt}:${disposition}:${hasMasterBlob ? '1' : '0'}`;
}
export function filesSessionContext(callerId, clientNonce, serverNonce, challengeId, expiresAt, disposition, hasMasterBlob) {
    return `${prefix}:session:${FILES_BOOTSTRAP_DESTINATION}:${callerId}:${clientNonce}:${serverNonce}:${challengeId}:${expiresAt}:${disposition}:${hasMasterBlob ? '1' : '0'}`;
}
export function filesUnlockProofInput(callerId, clientNonce, serverNonce, challengeId, expiresAt, disposition, hasMasterBlob, sealedUnlock) {
    const digest = createHash('sha256').update(sealedUnlock, 'utf8').digest('base64url');
    return `${prefix}:unlock:${FILES_BOOTSTRAP_DESTINATION}:${callerId}:${clientNonce}:${serverNonce}:${challengeId}:${expiresAt}:${disposition}:${hasMasterBlob ? '1' : '0'}:${digest}`;
}
