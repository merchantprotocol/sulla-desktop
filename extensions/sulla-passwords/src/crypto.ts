import { decryptItemText, deriveLoginHash, deriveMasterKey, encryptItem, unwrapUserKey, type EncryptedItem, type VaultItemPlaintext } from '../../../packages/vault-crypto/src/index.js';
export { decryptItemText, deriveLoginHash, deriveMasterKey, encryptItem, unwrapUserKey };
export type { EncryptedItem, VaultItemPlaintext };
export function encodeKey(key: Uint8Array): string { return btoa(String.fromCharCode(...key)); }
export function decodeKey(value: string): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
export function siteHost(url: string): string { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
export function uriMatches(uri: { uri: string; match?: string }, url: string): boolean {
  const target = new URL(url); const candidate = new URL(uri.uri); const mode = uri.match ?? 'domain';
  if (mode === 'never') return false; if (mode === 'exact') return target.href === candidate.href; if (mode === 'startsWith') return target.href.startsWith(candidate.href); if (mode === 'host') return target.hostname === candidate.hostname && target.port === candidate.port;
  return target.hostname === candidate.hostname || target.hostname.endsWith(`.${candidate.hostname}`);
}
export async function decryptItems(rows: any[], userKey: Uint8Array, userId: string): Promise<Array<VaultItemPlaintext & { id: string; revision: number; collectionId?: string }>> {
  const result: Array<VaultItemPlaintext & { id: string; revision: number; collectionId?: string }> = [];
  for (const row of rows) { try { const plaintext = JSON.parse(await decryptItemText(row as EncryptedItem, userKey, { itemId: row.id, ownerId: row.collection_id ?? userId })) as VaultItemPlaintext; result.push({ ...plaintext, id: row.id, revision: row.revision, collectionId: row.collection_id }); } catch { /* inaccessible collection item */ } }
  return result;
}
