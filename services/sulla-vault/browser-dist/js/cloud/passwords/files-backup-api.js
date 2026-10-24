// Same-origin encrypted Files backup API. It returns ciphertext only.
export function createFilesBackupApi() {
  async function req(path) {
    const res = await fetch(`/files-sync/v1${path}`, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Sulla-Vault-Request': '1' } });
    if (!res.ok) { const e = new Error(`Files backup returned ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }
  return {
    collections: () => req('/collections'),
    keys: (id) => req(`/collections/${encodeURIComponent(id)}/keys`),
    changes: (id, since = 0) => req(`/collections/${encodeURIComponent(id)}/changes?since=${encodeURIComponent(since)}&limit=500`),
    chunk: async (id, cid) => {
      const res = await fetch(`/files-sync/v1/collections/${encodeURIComponent(id)}/chunks/${encodeURIComponent(cid)}`, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Sulla-Vault-Request': '1' } });
      if (!res.ok) { const e = new Error(`Files backup returned ${res.status}`); e.status = res.status; throw e; }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
