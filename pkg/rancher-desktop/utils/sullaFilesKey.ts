import crypto from 'node:crypto';

/**
 * Key shared by Electron (signs Files capability tokens) and the sulla-files
 * container (verifies them). The container requires at least 32 bytes, so the
 * service password is stretched with HMAC-SHA256 instead of being used raw.
 */
export function sullaFilesCapabilityKey(servicePassword:string):string {
  return process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY ||
    crypto.createHmac('sha256', servicePassword).update('sulla-files-capability-v1').digest('hex');
}
