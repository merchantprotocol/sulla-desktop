(() => {
  'use strict';

  let csrf = '';
  let targetOrigin = '';
  const root = document.getElementById('popup-content');
  const svg = (name) => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'i sm');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${name}`);
    icon.append(use);
    return icon;
  };
  const notice = (text, error = false) => {
    const line = document.createElement('div');
    line.className = error ? 'save' : 'site';
    line.textContent = text;
    return line;
  };
  const api = async(path, options = {}) => {
    if (!csrf) throw new Error('The protected vault session is missing');
    const headers = new Headers(options.headers);
    headers.set('x-csrf-token', csrf);
    if (options.body) headers.set('content-type', 'application/json');
    const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', ...options, headers });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || body?.error || `Vault request failed (${response.status})`);
    return body;
  };
  const itemMatches = item => (item.uris || []).some(entry => {
    try { return new URL(entry.uri).origin === targetOrigin; } catch { return false; }
  });
  const renderMatches = async() => {
    root.replaceChildren();
    const search = document.createElement('div'); search.className = 'search'; search.append(svg('search'), document.createTextNode('Search this site'));
    const site = document.createElement('div'); site.className = 'site'; site.append(svg('lock'), document.createTextNode('Logins for '));
    const host = document.createElement('b'); host.textContent = targetOrigin ? new URL(targetOrigin).hostname : 'this page'; site.append(host);
    root.append(search, site);
    if (!targetOrigin) { root.append(notice('Open a web page before choosing a login.', true)); return; }
    const result = await api('/v1/human/items');
    const matches = (result.items || []).filter(itemMatches);
    if (!matches.length) { root.append(notice('No saved logins match this site.')); return; }
    matches.forEach((item, index) => {
      const row = document.createElement('div'); row.className = `match${index === 0 ? ' top' : ''}`;
      const tile = document.createElement('span'); tile.className = 'tile sm'; tile.textContent = (item.name || new URL(targetOrigin).hostname).slice(0, 2).toLowerCase();
      const meta = document.createElement('div'); meta.className = 'm';
      const name = document.createElement('b'); name.textContent = item.name || new URL(targetOrigin).hostname;
      const username = document.createElement('span'); username.textContent = item.username || 'Saved login';
      meta.append(name, username);
      const fill = document.createElement('button'); fill.type = 'button'; fill.className = 'fill'; fill.textContent = 'Fill';
      fill.onclick = async() => {
        fill.disabled = true; fill.textContent = 'Filling…';
        try {
          await api(`/v1/human/items/${encodeURIComponent(item.id)}/fill`, { method: 'POST', body: '{}' });
          fill.textContent = 'Filled';
        } catch (error) { fill.disabled = false; fill.textContent = 'Fill'; root.prepend(notice(error.message, true)); }
      };
      row.append(tile, meta, fill); root.append(row);
    });
  };
  const renderUnlock = () => {
    root.replaceChildren();
    const panel = document.createElement('form'); panel.className = 'save';
    const title = document.createElement('h4'); title.textContent = 'Unlock Sulla Passwords';
    const password = document.createElement('input'); password.type = 'password'; password.autocomplete = 'current-password'; password.placeholder = 'Vault password'; password.required = true;
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn primary'; submit.textContent = 'Unlock';
    const errorLine = document.createElement('div'); errorLine.className = 'small muted';
    panel.append(title, password, submit, errorLine); root.append(panel); password.focus();
    panel.onsubmit = async(event) => {
      event.preventDefault(); submit.disabled = true; errorLine.textContent = '';
      try {
        const result = await api('/v1/human/unlock', { method: 'POST', body: JSON.stringify({ password: password.value }) });
        csrf = result.csrf; password.value = ''; await renderMatches();
      } catch (error) { errorLine.textContent = error.message; submit.disabled = false; }
    };
  };
  const start = async() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const grant = fragment.get('grant'); csrf = fragment.get('csrf') || '';
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (!grant || !csrf) throw new Error('Open Sulla Passwords from the browser toolbar');
    const session = await api('/v1/human/session/exchange', { method: 'POST', body: JSON.stringify({ grant, csrf }) });
    csrf = session.csrf; targetOrigin = session.targetOrigin || '';
    if (session.phase === 'unlocked') await renderMatches(); else renderUnlock();
  };
  addEventListener('pagehide', () => { csrf = ''; targetOrigin = ''; });
  start().catch(error => root.replaceChildren(notice(error.message, true)));
})();
