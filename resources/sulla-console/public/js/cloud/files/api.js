// Sulla Server app: Files data layer. Thin wrapper over CloudApi for the
// /cloud-files endpoints (see merchantprotocol/sulla-workers
// src/routes/cloud-files.ts). No caching beyond what the screen keeps in
// memory for the current render — every call hits the real API.
(function () {
  'use strict';

  function qs(params) {
    const parts = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (!parts.length) return '';
    return '?' + parts.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  // Raw authenticated fetch for binary content: CloudApi.request always
  // parses JSON or text, which would corrupt bytes, so this goes straight
  // to SullaAuth's token + base URL. Used only for the content-request
  // download (requests that are still pending/failed come back as JSON,
  // which pollContent() checks before ever trying to read a blob).
  function rawFetch(path) {
    const token = window.SullaAuth?.getAccessToken?.();
    return fetch(`${window.SullaAuth.BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  }

  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = 20000;

  async function poll(checkOnce) {
    const startedAt = Date.now();
    for (;;) {
      const result = await checkOnce();
      if (result.status !== 'pending') return result;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) return { status: 'failed', error: 'Your Desktop did not respond in time. Make sure it is online and try again.' };
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  window.CloudFilesApi = {
    listFiles(opts = {}) {
      return window.CloudApi.get(`/cloud-files/v1/files${qs(opts)}`).then((r) => r.data);
    },
    // Asks the owning Desktop for a file's bytes (no public link). Resolves
    // to { status:'fulfilled', blob, contentType } or { status:'failed', error }.
    async requestContent(id, { download = false } = {}) {
      const { data } = await window.CloudApi.send('POST', `/cloud-files/v1/files/${encodeURIComponent(id)}/content-request`, {});
      const requestId = data.requestId;
      return poll(async () => {
        const res = await rawFetch(`/cloud-files/v1/content-requests/${encodeURIComponent(requestId)}${download ? '?download=1' : ''}`);
        if (res.status === 202) return { status: 'pending' };
        if (!res.ok) { const body = await res.json().catch(() => ({})); return { status: 'failed', error: body.error || `Sulla Server returned ${res.status}` }; }
        const contentType = res.headers.get('content-type') || 'application/octet-stream';
        if (contentType.includes('application/json')) {
          const body = await res.json();
          if (body.status === 'pending') return { status: 'pending' };
          return { status: body.status || 'failed', error: body.error };
        }
        return { status: 'fulfilled', blob: await res.blob(), contentType };
      });
    },
    // Asks the owning Desktop to mint a public link. Resolves to
    // { status:'fulfilled', linkId, url } or { status:'failed', error }.
    async requestLink(id, accessMode) {
      const { data } = await window.CloudApi.send('POST', `/cloud-files/v1/files/${encodeURIComponent(id)}/share`, { visibility: 'link', accessMode, confirmPublic: true });
      const requestId = data.requestId;
      return poll(async () => {
        const res = await window.CloudApi.get(`/cloud-files/v1/link-requests/${encodeURIComponent(requestId)}`);
        return res.data;
      });
    },
    getFile(id) {
      return window.CloudApi.get(`/cloud-files/v1/files/${encodeURIComponent(id)}`).then((r) => r.data.file);
    },
    listTrash() { return window.CloudApi.get('/cloud-files/v1/trash').then((r) => r.data); },
    restore(id) { return window.CloudApi.send('POST', `/cloud-files/v1/documents/${encodeURIComponent(id)}/restore`).then((r) => r.data); },
    deleteForever(id) { return window.CloudApi.send('DELETE', `/cloud-files/v1/trash/${encodeURIComponent(id)}`); },
    deleteDocument(id) { return window.CloudApi.send('DELETE', `/cloud-files/v1/documents/${encodeURIComponent(id)}`); },
    listTrash() { return window.CloudApi.get('/cloud-files/v1/trash').then((r) => r.data); },
    restore(id) { return window.CloudApi.send('POST', `/cloud-files/v1/documents/${encodeURIComponent(id)}/restore`).then((r) => r.data); },
    deleteForever(id) { return window.CloudApi.send('DELETE', `/cloud-files/v1/trash/${encodeURIComponent(id)}`); },
    deleteDocument(id) { return window.CloudApi.send('DELETE', `/cloud-files/v1/documents/${encodeURIComponent(id)}`); },
    listShared() {
      return window.CloudApi.get('/cloud-files/v1/shared').then((r) => r.data);
    },
    share(id, body) {
      return window.CloudApi.send('POST', `/cloud-files/v1/files/${encodeURIComponent(id)}/share`, body).then((r) => r.data);
    },
    revokeGrant(id, grantId) {
      return window.CloudApi.send('DELETE', `/cloud-files/v1/files/${encodeURIComponent(id)}/share/grant/${encodeURIComponent(grantId)}`);
    },
    revokeLink(id, linkId) {
      return window.CloudApi.send('DELETE', `/cloud-files/v1/files/${encodeURIComponent(id)}/share/link/${encodeURIComponent(linkId)}`);
    },
    createDocument(body) {
      return window.CloudApi.send('POST', '/cloud-files/v1/documents', body).then((r) => r.data.document);
    },
    getDocument(id) {
      return window.CloudApi.get(`/cloud-files/v1/documents/${encodeURIComponent(id)}`).then((r) => r.data);
    },
    saveDocument(id, body) {
      return window.CloudApi.send('PUT', `/cloud-files/v1/documents/${encodeURIComponent(id)}`, body).then((r) => r.data);
    },
    openShareDialog(item, { shell = window.CloudShell, onShared } = {}) {
      const isDoc = item.itemType === 'document';
      document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop open" data-share-modal>
        <form class="action-modal" data-share-form>
          <h2>Share "${shell.esc(item.name)}"</h2>
          <label class="radiorow"><input type="radio" name="visibility" value="org" checked><span><b>Share with this organization</b><br><span class="dim" style="font-size:12px">Everyone in this organization will be able to find and open this${isDoc ? ' Sulla document' : ''}.</span></span></label>
          ${isDoc ? '' : `<label class="radiorow"><input type="radio" name="visibility" value="link"><span><b>Create a public link</b><br><span class="dim" style="font-size:12px">Anyone with the link can ${item.kind === 'folder' ? 'open' : 'view or download'} this — no sign-in required. Your Desktop must be online to create it.</span></span></label>
          <div class="linkopts" hidden style="margin:4px 0 0 26px"><label class="sel"><span>Access</span><select name="accessMode"><option value="view">View</option><option value="download">View and download</option></select></label><label class="radiorow"><input type="checkbox" name="confirmPublic" value="yes"><span>I understand anyone with this link can open it without signing in.</span></label></div>`}
          <div class="modal-actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn pri" type="submit">Share</button></div>
        </form>
      </div>`);
      const modal = document.querySelector('[data-share-modal]');
      const form = modal.querySelector('form');
      const linkOpts = form.querySelector('.linkopts');
      modal.addEventListener('click', (event) => { if (event.target === modal || event.target.closest('[data-cancel]')) modal.remove(); });
      form.addEventListener('change', (event) => { if (event.target.name === 'visibility' && linkOpts) linkOpts.hidden = event.target.value !== 'link'; });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('[type=submit]');
        const visibility = form.querySelector('input[name=visibility]:checked')?.value || 'org';
        button.disabled = true;
        try {
          if (visibility === 'link') {
            if (!form.querySelector('input[name=confirmPublic]')?.checked) throw new Error('Confirm that anyone with the link can open it.');
            button.textContent = 'Asking your Desktop…';
            const result = await this.requestLink(item.id, form.querySelector('select[name=accessMode]')?.value || 'view');
            if (result.status !== 'fulfilled') throw new Error(result.error || 'Your Desktop could not create this link.');
            shell.toast('Public link created.');
          } else {
            await this.share(item.id, { visibility: 'org' });
            shell.toast('Shared.');
          }
          modal.remove();
          onShared?.();
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Share';
          shell.toast(window.CloudStates.errorText(error) || error.message || 'Could not share this item.');
        }
      });
      return modal;
    },
  };
})();
