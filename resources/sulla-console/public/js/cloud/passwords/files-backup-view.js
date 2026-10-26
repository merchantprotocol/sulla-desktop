import { createFilesBackupApi } from './files-backup-api.js';
const api = createFilesBackupApi();
const esc = (s) => window.CloudShell.esc(String(s ?? ''));
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function folderTree(files) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.path || file.name || '').split('/').filter(Boolean);
    const name = parts.pop() || file.name || 'download';
    let node = root;
    for (const part of parts) { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); node = node.folders.get(part); }
    node.files.push({ ...file, name });
  }
  const render = (node) => `${[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => `<details class="files-folder"><summary>${esc(name)}</summary>${render(child)}</details>`).join('')}${node.files.sort((a, b) => a.name.localeCompare(b.name)).map((file) => `<div class="files-backup-row"><span><b>${esc(file.name)}</b><small>${esc(file.mime || 'file')} · ${bytes(file.size || 0)} · ${esc(file.mtime || '—')}</small></span><button class="btn" type="button" data-download="${esc(file.fileId)}">Download</button></div>`).join('')}`;
  return render(root);
}

export async function renderFilesBackup({ view, client }) {
  view.innerHTML = '<div class="vc"><section class="unlock-wrap"><div class="unlock-card card"><p class="eyebrow">Sulla Server · Files backup</p><h1 class="title">Encrypted Files backup</h1><p class="lead">Checking encrypted collections…</p></div></section></div>';
  try {
    const result = await api.collections(); const collections = result.collections || result.data || [];
    if (!collections.length) { view.querySelector('.lead').textContent = 'No collections backed up yet.'; return; }
    const all = [];
    for (const collection of collections) {
      const collectionId = collection.collectionId || collection.id;
      const keys = await api.keys(collectionId); const key = (keys.keys || keys)[0];
      if (!key) throw new Error('Encrypted backup escrow is missing.');
      const pages = []; let since = 0; let head = null;
      for (;;) {
        const page = await api.changes(collectionId, since); pages.push(page); head = page.head || head;
        const versions = page.versions || [];
        if (versions.length) since = Math.max(since, ...versions.map((v) => Number(v.seq) || 0));
        if (versions.length < 500) break;
      }
      const loaded = await client.filesLoadCollection(collectionId, key.escrow || key, pages, head);
      all.push(...loaded.files.map((file) => ({ ...file, collectionId })));
    }
    view.innerHTML = `<div class="vc"><section class="unlock-wrap"><div class="unlock-card card"><p class="eyebrow">Sulla Server · Files backup</p><h1 class="title">Encrypted Files backup</h1><p class="lead">${all.length ? 'Verified files from your encrypted backup.' : 'No files backed up yet.'}</p><div class="files-backup-tree">${folderTree(all)}</div><p class="dim">Keys and plaintext stay in the locked crypto worker.</p></div></section></div>`;
    view.querySelectorAll('[data-download]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const file = all.find((item) => item.fileId === button.dataset.download);
        const ids = await client.filesChunkIds(file.collectionId, file.fileId);
        const wires = await Promise.all(ids.map(async (id) => ({ id, wire: await api.chunk(file.collectionId, id) })));
        const plaintext = await client.filesDownload(file.collectionId, file.fileId, wires);
        const blob = new Blob([plaintext], { type: file.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = file.name || 'download'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch { window.CloudShell.toast('Download failed integrity verification.'); }
      finally { button.disabled = false; }
    }));
  } catch (error) {
    view.innerHTML = `<div class="vc"><section class="unlock-wrap"><div class="unlock-card card"><p class="eyebrow">Sulla Server · Files backup</p><h1 class="title">Integrity failure</h1><p class="lead error">${esc(error.message || 'Encrypted backup could not be verified. Nothing was shown.')}</p></div></section></div>`;
  }
}
