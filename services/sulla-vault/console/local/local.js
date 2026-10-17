(() => {
  'use strict';

  let csrf = '';
  let items = [];
  let selectedId = '';
  let category = 'all';
  let accessFilter = 'all';
  let query = '';
  const initialUrl = new URL(location.href);
  const integrationHint = initialUrl.searchParams.get('integration');
  const accountHint = initialUrl.searchParams.get('account');
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const defaultPolicy = () => ({ mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false });
  const policy = item => ({ ...defaultPolicy(), ...(item?.agentPolicy || {}) });
  const entries = value => value.split(',').map(entry => entry.trim()).filter(Boolean);
  const sites = value => entries(value).map(entry => entry.toLowerCase());
  const initials = item => (item?.name || item?.integration?.integrationId || '--').split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  const typeLabel = type => ({ login: 'Login', apiKey: 'API key', card: 'Card', note: 'Secure note', identity: 'Identity' })[type] || type || 'Item';
  const dateText = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never';
  const localDateValue = value => {
    if (!value) return '';
    const date = new Date(value);
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
  };
  const message = (text, error = false) => {
    const output = byId('vault-message');
    output.textContent = text;
    output.classList.toggle('error', error);
    if (text) setTimeout(() => { if (output.textContent === text) output.textContent = ''; }, 4_000);
  };
  const api = async(path, options = {}, responseType = 'json') => {
    if (!csrf) throw new Error('The vault session is missing its CSRF binding');
    const headers = new Headers(options.headers);
    headers.set('x-csrf-token', csrf);
    if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
    const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', ...options, headers });
    const body = response.status === 204 ? null : responseType === 'blob' ? await response.blob() : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || body?.error || `Vault request failed (${response.status})`);
    return body;
  };
  const setPhase = phase => {
    const unlocked = phase === 'unlocked';
    byId('state').textContent = unlocked ? '● Unlocked' : 'Locked';
    byId('unlock').hidden = unlocked;
    byId('vault').hidden = !unlocked;
  };

  const visibleItems = () => items.filter(item => {
    if (category === 'favorite' && !item.favorite) return false;
    if (!['all', 'favorite'].includes(category) && item.type !== category) return false;
    if (accessFilter !== 'all' && policy(item).mode !== accessFilter) return false;
    const haystack = [item.name, item.username, item.uris?.[0]?.uri, item.integration?.integrationId, item.integration?.accountId].filter(Boolean).join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });

  const updateCounts = () => {
    const count = name => items.filter(item => name === 'all' || (name === 'favorite' ? item.favorite : item.type === name)).length;
    for (const name of ['all', 'favorite', 'login', 'apiKey', 'card', 'note']) byId(`count-${name}`).textContent = String(count(name));
    byId('filter-all').textContent = String(items.length);
    byId('filter-only').textContent = String(items.filter(item => policy(item).mode === 'only_me').length);
    byId('filter-agents').textContent = String(items.filter(item => policy(item).mode === 'agents').length);
    byId('search').placeholder = `Search ${items.length} item${items.length === 1 ? '' : 's'}`;
  };

  const renderItems = () => {
    updateCounts();
    const root = byId('items');
    root.replaceChildren();
    const visible = visibleItems();
    if (!visible.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      empty.innerHTML = `<b>${items.length ? 'No items match this view' : 'No vault items yet'}</b><span>${items.length ? 'Try another category or search.' : 'Create an item to store your first credential.'}</span>`;
      root.append(empty); return;
    }
    for (const item of visible) {
      const itemPolicy = policy(item);
      const row = document.createElement('button'); row.type = 'button'; row.className = `item-row${selectedId === item.id ? ' selected' : ''}`;
      const tile = document.createElement('span'); tile.className = 'tile'; tile.textContent = initials(item);
      const meta = document.createElement('span'); meta.className = 'meta';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name || 'Untitled';
      const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = [item.username, item.uris?.[0]?.uri, typeLabel(item.type)].filter(Boolean).join(' · ');
      meta.append(name, sub);
      const summary = document.createElement('span'); summary.className = 'policy-summary';
      const level = document.createElement('span'); level.className = `lvl ${itemPolicy.level === 'full' ? 'l3' : itemPolicy.level === 'autofill' ? 'l2' : itemPolicy.mode === 'agents' ? 'l1' : ''}`; level.textContent = itemPolicy.mode === 'agents' ? itemPolicy.level.toUpperCase() : 'NONE';
      const who = document.createElement('span'); who.className = `who ${itemPolicy.mode === 'agents' ? 'agents' : 'personal'}`; who.textContent = itemPolicy.mode === 'agents' ? '◆ Agents can use' : '⌑ Only me';
      summary.append(level, who); row.append(tile, meta, summary);
      row.onclick = () => { void selectItem(item.id); };
      root.append(row);
    }
  };

  const detailField = (label, value, secret = false) => {
    const row = document.createElement('div'); row.className = 'detail-field';
    const key = document.createElement('span'); key.className = 'k'; key.textContent = label;
    const output = document.createElement('span'); output.className = 'v'; output.textContent = secret ? '••••••••••••' : (value || '—');
    row.append(key, output);
    if (secret && value) {
      const reveal = document.createElement('button'); reveal.type = 'button'; reveal.textContent = 'Reveal'; let shown = false;
      reveal.onclick = () => { shown = !shown; output.textContent = shown ? value : '••••••••••••'; reveal.textContent = shown ? 'Hide' : 'Reveal'; if (shown) setTimeout(() => { shown = false; output.textContent = '••••••••••••'; reveal.textContent = 'Reveal'; }, 30_000); };
      row.append(reveal);
    }
    return row;
  };

  const selectItem = async id => {
    selectedId = id; renderItems();
    byId('detail-empty').hidden = true; byId('detail-content').hidden = false;
    try {
      const [revealed, activity] = await Promise.all([
        api(`/v1/human/items/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: '{}' }),
        api(`/v1/human/activity?item=${encodeURIComponent(id)}`).catch(() => ({ events: [] })),
      ]);
      const item = { ...revealed.item, id: revealed.id, revision: revealed.revision };
      const itemPolicy = policy(item);
      byId('detail-tile').textContent = initials(item); byId('detail-name').textContent = item.name || 'Untitled';
      byId('detail-meta').textContent = `${typeLabel(item.type)} · edited ${dateText(items.find(value => value.id === id)?.updatedAt)}`;
      const fields = byId('detail-fields'); fields.replaceChildren();
      if (item.username) fields.append(detailField('Username', item.username));
      if (item.password) fields.append(detailField(item.type === 'apiKey' ? 'Secret' : 'Password', item.password, true));
      for (const [name, value] of Object.entries(item.integration?.properties || {})) fields.append(detailField(name, value, true));
      if (item.uris?.[0]?.uri) fields.append(detailField('Website', item.uris[0].uri));
      if (item.notes) fields.append(detailField('Notes', item.notes));
      if (!fields.children.length) fields.append(detailField('Details', 'No additional fields'));
      const enabled = itemPolicy.mode === 'agents';
      byId('detail-access-title').textContent = enabled ? 'Agents can use this' : 'Only you can use this';
      byId('detail-access-copy').textContent = enabled ? (itemPolicy.level === 'autofill' ? 'Sulla can use it without revealing the secret.' : `Agents have ${itemPolicy.level} access.`) : 'Agents cannot use this item.';
      [...byId('detail-ladder').children].forEach((node, index) => node.classList.toggle('on', index === (enabled ? { metadata: 1, autofill: 2, full: 3 }[itemPolicy.level] : 0)));
      byId('detail-agents').textContent = enabled ? (itemPolicy.agents.length ? itemPolicy.agents.join(', ') : 'All my agents') : 'None';
      byId('detail-sites').textContent = itemPolicy.sites.length ? itemPolicy.sites.join(', ') : 'Any registered destination';
      byId('detail-expiry').textContent = dateText(itemPolicy.expiresAt); byId('detail-ask').textContent = itemPolicy.askFirst ? 'Every use' : 'No';
      const events = activity.events || []; byId('activity-count').textContent = String(events.length);
      byId('detail-activity').innerHTML = events.length ? events.slice(0, 6).map(event => `<div class="activity-event"><b>${esc(event.blocked ? 'Blocked agent request' : 'Agent used this item')}</b><span>${esc(dateText(event.created_at))}</span><span>${esc(event.metadata?.agentId || event.metadata?.operation || 'Sulla agent')}</span><span>${event.blocked ? 'Blocked' : 'Allowed'}</span></div>`).join('') : '<div class="honest-state">No recorded agent activity for this item.</div>';
      byId('edit-item').onclick = () => { void openEditor(item); };
    } catch (error) { message(error.message, true); }
  };

  const load = async() => {
    const result = await api('/v1/human/items'); items = result.items || [];
    if (selectedId && !items.some(item => item.id === selectedId)) selectedId = '';
    renderItems();
    if (selectedId) await selectItem(selectedId);
  };

  const renderIntegrationProperties = properties => {
    const root = byId('integration-properties'); root.replaceChildren();
    const values = Object.entries(properties || {}); if (!values.length) values.push(['api_key', '']);
    for (const [name, value] of values.slice(0, 20)) addPropertyRow(name, value);
  };
  const addPropertyRow = (name = '', value = '') => {
    const root = byId('integration-properties'); const row = document.createElement('div'); row.className = 'property-row';
    const key = document.createElement('input'); key.className = 'integration-property-name'; key.placeholder = 'Property name'; key.value = name; key.autocomplete = 'off';
    const secret = document.createElement('input'); secret.className = 'integration-property-value'; secret.type = 'password'; secret.placeholder = 'Secret value'; secret.value = value; secret.autocomplete = 'new-password';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn sm'; remove.textContent = 'Remove'; remove.onclick = () => row.remove();
    row.append(key, secret, remove); root.append(row); return key;
  };
  const readIntegrationProperties = () => {
    const rows = [...document.querySelectorAll('.property-row')]; if (!rows.length || rows.length > 20) throw new Error('Integration credentials require 1–20 properties');
    const properties = {};
    for (const row of rows) { const name = row.querySelector('.integration-property-name').value.trim(); const value = row.querySelector('.integration-property-value').value; if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error('Property names may use letters, numbers, dot, dash, and underscore'); if (Object.hasOwn(properties, name)) throw new Error(`Duplicate integration property: ${name}`); properties[name] = value; }
    return properties;
  };
  const setPolicyLevel = level => {
    byId('policy-level').value = level;
    document.querySelectorAll('[data-level]').forEach(button => button.classList.toggle('on', button.dataset.level === level));
  };
  const syncPolicyEnabled = () => {
    const enabled = byId('agent-enabled').checked; byId('policy-mode').value = enabled ? 'agents' : 'only_me';
    byId('item-form').classList.toggle('policy-disabled', !enabled);
  };
  const showBrowser = () => { byId('editor-view').hidden = true; byId('browser-view').hidden = false; };
  const openEditor = async item => {
    byId('item-form').reset(); let detail = item;
    if (item?.id && !item.password && !item.integration?.properties) { const revealed = await api(`/v1/human/items/${encodeURIComponent(item.id)}/reveal`, { method: 'POST', body: '{}' }); detail = { ...revealed.item, id: revealed.id, revision: revealed.revision }; }
    const itemPolicy = policy(detail);
    byId('item-id').value = detail?.id || ''; byId('revision').value = detail?.revision || ''; byId('item-type').value = detail?.integration ? 'integration' : detail?.type || 'login';
    byId('name').value = detail?.name || ''; byId('username').value = detail?.username || detail?.integration?.accountId || ''; byId('item-password').value = detail?.password || ''; byId('website').value = detail?.uris?.[0]?.uri || ''; byId('notes').value = detail?.notes || ''; byId('favorite').checked = Boolean(detail?.favorite);
    byId('integration-id').value = detail?.integration?.integrationId || ''; byId('account-id').value = detail?.integration?.accountId || ''; renderIntegrationProperties(detail?.integration?.properties);
    byId('agent-enabled').checked = itemPolicy.mode === 'agents'; byId('policy-mode').value = itemPolicy.mode; setPolicyLevel(itemPolicy.level); byId('ask-first').checked = Boolean(itemPolicy.askFirst); byId('allow-server-agents').checked = Boolean(itemPolicy.allowServerAgents); byId('policy-agents').value = itemPolicy.agents.join(', '); byId('policy-sites').value = itemPolicy.sites.join(', '); byId('policy-expiry').value = localDateValue(itemPolicy.expiresAt); syncPolicyEnabled();
    const integration = byId('item-type').value === 'integration'; byId('integration-fields').hidden = !integration; byId('item-secret-field').hidden = integration;
    byId('delete-item').hidden = !detail?.id; byId('editor-title').textContent = detail?.id ? `Edit ${detail.name}` : 'New vault item'; byId('editor-crumb').textContent = detail?.name || 'New item'; byId('editor-tile').textContent = initials(detail) || '＋';
    byId('browser-view').hidden = true; byId('editor-view').hidden = false; byId('name').focus();
  };
  const itemPayload = () => {
    const type = byId('item-type').value; const origin = byId('website').value.trim(); const expiry = byId('policy-expiry').value;
    const item = { type: type === 'integration' ? 'apiKey' : type, name: byId('name').value.trim(), favorite: byId('favorite').checked, username: byId('username').value, password: byId('item-password').value, notes: byId('notes').value, uris: origin ? [{ uri: origin }] : [], agentPolicy: { mode: byId('policy-mode').value, level: byId('policy-level').value, agents: entries(byId('policy-agents').value), sites: sites(byId('policy-sites').value), expiresAt: expiry ? new Date(expiry).toISOString() : null, askFirst: byId('ask-first').checked, allowServerAgents: byId('allow-server-agents').checked } };
    if (type === 'integration') item.integration = { integrationId: byId('integration-id').value.trim(), accountId: byId('account-id').value.trim(), properties: readIntegrationProperties() };
    return item;
  };
  const openIntegrationHint = async() => {
    if (!integrationHint) return;
    if (accountHint) for (const item of items.slice(0, 200)) { const revealed = await api(`/v1/human/items/${encodeURIComponent(item.id)}/reveal`, { method: 'POST', body: '{}' }); if (revealed.item?.integration?.integrationId === integrationHint && revealed.item?.integration?.accountId === accountHint) { await openEditor({ ...revealed.item, id: revealed.id, revision: revealed.revision }); return; } }
    await openEditor({ type: 'apiKey', name: integrationHint, integration: { integrationId: integrationHint, accountId: accountHint || 'default', properties: {} } });
  };

  const start = async() => {
    const fragment = new URLSearchParams(location.hash.slice(1)); const grant = fragment.get('grant'); csrf = fragment.get('csrf') || ''; history.replaceState(null, '', '/vault/');
    if (!csrf) throw new Error('Open the vault from Sulla Desktop to start a protected session');
    const session = grant ? await api('/v1/human/session/exchange', { method: 'POST', body: JSON.stringify({ grant, csrf }) }) : await api('/v1/human/session');
    csrf = session.csrf; setPhase(session.phase);
    if (session.phase === 'unlocked') { await load(); await openIntegrationHint(); } else { byId('unlock-title').textContent = session.setupRequired ? 'Create your vault password' : 'Unlock your vault'; byId('password').autocomplete = session.setupRequired ? 'new-password' : 'current-password'; }
  };

  byId('unlock-form').onsubmit = async event => { event.preventDefault(); byId('unlock-error').textContent = ''; try { const result = await api('/v1/human/unlock', { method: 'POST', body: JSON.stringify({ password: byId('password').value }) }); csrf = result.csrf; byId('password').value = ''; setPhase('unlocked'); await load(); await openIntegrationHint(); } catch (error) { byId('unlock-error').textContent = error.message; } };
  byId('recovery-unlock-form').onsubmit = async event => { event.preventDefault(); try { const result = await api('/v1/human/recovery/unlock', { method: 'POST', body: JSON.stringify({ recoveryCode: byId('recovery-code').value.trim(), nextPassword: byId('recovery-password').value }) }); csrf = result.csrf; event.target.reset(); setPhase('unlocked'); await load(); await openIntegrationHint(); } catch (error) { byId('unlock-error').textContent = error.message; } };
  byId('new-item').onclick = () => { void openEditor(null).catch(error => message(error.message, true)); };
  byId('item-type').onchange = () => { const integration = byId('item-type').value === 'integration'; byId('integration-fields').hidden = !integration; byId('item-secret-field').hidden = integration; if (integration && !byId('integration-properties').children.length) renderIntegrationProperties({}); };
  byId('add-integration-property').onclick = () => { if (byId('integration-properties').children.length >= 20) return message('Integration properties are limited to 20.', true); addPropertyRow().focus(); };
  byId('agent-enabled').onchange = syncPolicyEnabled;
  document.querySelectorAll('[data-level]').forEach(button => button.onclick = () => setPolicyLevel(button.dataset.level));
  for (const id of ['cancel', 'editor-back']) byId(id).onclick = showBrowser;
  byId('search').oninput = event => { query = event.target.value.trim().toLowerCase(); renderItems(); };
  addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); byId('search').focus(); } });
  document.querySelectorAll('[data-category]').forEach(button => button.onclick = () => { category = button.dataset.category; document.querySelectorAll('[data-category]').forEach(value => value.classList.toggle('on', value === button)); renderItems(); });
  document.querySelectorAll('[data-access]').forEach(button => button.onclick = () => { accessFilter = button.dataset.access; document.querySelectorAll('[data-access]').forEach(value => value.classList.toggle('on', value === button)); renderItems(); });
  document.querySelectorAll('[data-panel-open]').forEach(button => button.onclick = () => { const panel = button.dataset.panelOpen; byId('utility-title').textContent = panel === 'security' ? 'Security & recovery' : 'Encrypted backup'; document.querySelectorAll('[data-utility]').forEach(value => { value.hidden = value.dataset.utility !== panel; }); byId('utility-dialog').showModal(); });
  byId('utility-close').onclick = () => byId('utility-dialog').close();
  byId('item-form').onsubmit = async event => { event.preventDefault(); const id = byId('item-id').value; const revision = Number(byId('revision').value || 0); try { const result = await api(id ? `/v1/human/items/${encodeURIComponent(id)}` : '/v1/human/items', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(id ? { item: itemPayload(), revision } : { item: itemPayload() }) }); byId('item-password').value = ''; selectedId = result.id; await load(); showBrowser(); message('Item saved.'); } catch (error) { message(error.message, true); } };
  byId('delete-item').onclick = async() => { const id = byId('item-id').value; if (!id || !confirm('Delete this vault item?')) return; try { await api(`/v1/human/items/${encodeURIComponent(id)}?revision=${encodeURIComponent(byId('revision').value)}`, { method: 'DELETE' }); selectedId = ''; await load(); showBrowser(); byId('detail-content').hidden = true; byId('detail-empty').hidden = false; message('Item deleted.'); } catch (error) { message(error.message, true); } };
  byId('password-form').onsubmit = async event => { event.preventDefault(); try { const result = await api('/v1/human/password', { method: 'POST', body: JSON.stringify({ currentPassword: byId('current-password').value, nextPassword: byId('new-password').value }) }); if (result?.csrf) csrf = result.csrf; event.target.reset(); message('Password changed. Use the new password next start.'); } catch (error) { message(error.message, true); } };
  byId('recovery-form').onsubmit = async event => { event.preventDefault(); try { const bytes = crypto.getRandomValues(new Uint8Array(32)); const recoveryCode = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); bytes.fill(0); await api('/v1/human/recovery/configure', { method: 'POST', body: JSON.stringify({ recoveryCode }) }); event.target.reset(); byId('recovery-output').hidden = false; byId('recovery-output').textContent = recoveryCode; message('Recovery code generated. Save it now; it will not be shown again.'); } catch (error) { message(error.message, true); } };
  byId('backup-export-form').onsubmit = async event => { event.preventDefault(); try { const backup = await api('/v1/human/backup/export', { method: 'POST', body: JSON.stringify({ backupPassword: byId('backup-export-password').value }) }); const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `sulla-vault-backup-${new Date().toISOString().slice(0, 10)}.vault`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); event.target.reset(); message('Encrypted backup downloaded.'); } catch (error) { message(error.message, true); } };
  byId('backup-import-form').onsubmit = async event => { event.preventDefault(); try { const file = byId('backup-file').files[0]; if (file.size > 25 * 1024 * 1024) throw new Error('Backup files are limited to 25 MB'); const backup = JSON.parse(await file.text()); await api('/v1/human/backup/import', { method: 'POST', body: JSON.stringify({ backupPassword: byId('backup-import-password').value, backup }) }); event.target.reset(); byId('unlock-error').textContent = 'Backup restored. Unlock it with the vault password from that backup.'; } catch (error) { byId('unlock-error').textContent = error.message; } };
  byId('lock').onclick = async() => { try { const next = await api('/v1/human/lock', { method: 'POST', body: '{}' }); if (!next?.csrf || next.phase !== 'pre-unlock') throw new Error('Vault lock did not rotate the protected session'); csrf = next.csrf; items = []; selectedId = ''; renderItems(); showBrowser(); document.querySelectorAll('form').forEach(form => form.reset()); renderIntegrationProperties({}); byId('recovery-output').textContent = ''; byId('recovery-output').hidden = true; message(''); setPhase(next.phase); } catch (error) { message(error.message, true); } };
  addEventListener('pagehide', () => { csrf = ''; items = []; });
  start().catch(error => { byId('state').textContent = 'Unavailable'; byId('unlock').hidden = false; byId('unlock-error').textContent = error.message; });
})();
