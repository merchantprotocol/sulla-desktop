(() => {
  'use strict';

  let csrf = '';
  let items = [];
  const initialUrl = new URL(location.href);
  const integrationHint = initialUrl.searchParams.get('integration');
  const accountHint = initialUrl.searchParams.get('account');
  const byId = id => document.getElementById(id);
  const message = (text, error = false) => {
    const output = byId('vault-message');
    output.textContent = text;
    output.classList.toggle('error', error);
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
    byId('state').textContent = unlocked ? 'Unlocked' : 'Locked';
    byId('unlock').hidden = unlocked;
    byId('vault').hidden = !unlocked;
    byId('lock').hidden = !unlocked;
  };
  const policy = item => item?.agentPolicy || { mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false };
  const entries = value => value.split(',').map(entry => entry.trim()).filter(Boolean);
  const sites = value => entries(value).map(entry => entry.toLowerCase());
  const renderIntegrationProperties = properties => {
    const root = byId('integration-properties'); root.replaceChildren();
    const values = Object.entries(properties || {}); if (!values.length) values.push(['api_key', '']);
    for (const [name, value] of values.slice(0, 20)) {
      const row = document.createElement('div'); row.className = 'property-row';
      const key = document.createElement('input'); key.className = 'integration-property-name'; key.placeholder = 'Property name'; key.value = name; key.autocomplete = 'off';
      const secret = document.createElement('input'); secret.className = 'integration-property-value'; secret.type = 'password'; secret.placeholder = 'Secret value'; secret.value = value; secret.autocomplete = 'new-password';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove'; remove.onclick = () => row.remove();
      row.append(key, secret, remove); root.append(row);
    }
  };
  const readIntegrationProperties = () => {
    const rows = [...document.querySelectorAll('.property-row')];
    if (!rows.length || rows.length > 20) throw new Error('Integration credentials require 1–20 properties');
    const properties = {};
    for (const row of rows) {
      const name = row.querySelector('.integration-property-name').value.trim();
      const value = row.querySelector('.integration-property-value').value;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error('Property names may use letters, numbers, dot, dash, and underscore');
      if (Object.hasOwn(properties, name)) throw new Error(`Duplicate integration property: ${name}`);
      properties[name] = value;
    }
    return properties;
  };

  const renderItems = () => {
    const root = byId('items');
    root.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No vault items yet.'; root.append(empty); return;
    }
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'item';
      const summary = document.createElement('div');
      const name = document.createElement('div'); name.className = 'item-name'; name.textContent = item.name || 'Untitled';
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = [item.type, item.username, item.integration?.provider, item.uris?.[0]?.uri].filter(Boolean).join(' · ');
      const secret = document.createElement('div'); secret.className = 'revealed'; secret.hidden = true;
      summary.append(name, meta, secret);
      const actions = document.createElement('div'); actions.className = 'item-actions';
      const reveal = document.createElement('button'); reveal.className = 'secondary'; reveal.textContent = 'Reveal';
      reveal.onclick = async() => {
        try {
          const detail = await api(`/v1/human/items/${encodeURIComponent(item.id)}/reveal`, { method: 'POST', body: '{}' });
          secret.textContent = detail.item?.password || detail.item?.integration?.secret || 'No secret value'; secret.hidden = false;
          reveal.textContent = 'Hide'; reveal.onclick = () => { secret.textContent = ''; secret.hidden = true; renderItems(); };
          setTimeout(() => { secret.textContent = ''; secret.hidden = true; }, 30_000);
        } catch (error) { message(error.message, true); }
      };
      const edit = document.createElement('button'); edit.textContent = 'Edit';
      edit.onclick = () => { void openEditor(item).catch(error => message(error.message, true)); };
      actions.append(reveal, edit); row.append(summary, actions); root.append(row);
    }
  };
  const load = async() => {
    const result = await api('/v1/human/items');
    items = result.items || [];
    renderItems();
  };
  const openEditor = async(item) => {
    byId('item-form').reset();
    let detail = item;
    if (item?.id) {
      try { const revealed = await api(`/v1/human/items/${encodeURIComponent(item.id)}/reveal`, { method: 'POST', body: '{}' }); detail = { ...revealed.item, id: revealed.id, revision: revealed.revision }; }
      catch (error) { message(error.message, true); return; }
    }
    byId('item-id').value = detail?.id || '';
    byId('revision').value = detail?.revision || '';
    byId('item-type').value = detail?.integration ? 'integration' : detail?.type || 'login';
    byId('name').value = detail?.name || '';
    byId('username').value = detail?.username || detail?.integration?.accountId || '';
    byId('item-password').value = detail?.password || '';
    byId('website').value = detail?.uris?.[0]?.uri || '';
    byId('notes').value = detail?.notes || '';
    byId('integration-id').value = detail?.integration?.integrationId || '';
    byId('account-id').value = detail?.integration?.accountId || '';
    renderIntegrationProperties(detail?.integration?.properties);
    byId('policy-mode').value = policy(detail).mode || 'only_me';
    byId('policy-level').value = policy(detail).level || 'metadata';
    byId('ask-first').checked = Boolean(policy(detail).askFirst);
    byId('allow-server-agents').checked = Boolean(policy(detail).allowServerAgents);
    byId('policy-agents').value = (policy(detail).agents || []).join(', ');
    byId('policy-sites').value = (policy(detail).sites || []).join(', ');
    byId('integration-fields').hidden = byId('item-type').value !== 'integration';
    byId('item-secret-field').hidden = byId('item-type').value === 'integration';
    byId('delete-item').hidden = !detail?.id;
    byId('editor').showModal();
  };
  const openIntegrationHint = async() => {
    if (!integrationHint) return;
    if (accountHint) {
      for (const item of items.slice(0, 200)) {
        const revealed = await api(`/v1/human/items/${encodeURIComponent(item.id)}/reveal`, { method: 'POST', body: '{}' });
        if (revealed.item?.integration?.integrationId === integrationHint && revealed.item?.integration?.accountId === accountHint) {
          await openEditor({ ...revealed.item, id: revealed.id, revision: revealed.revision }); return;
        }
      }
    }
    await openEditor({ type: 'apiKey', name: integrationHint, integration: { integrationId: integrationHint, accountId: accountHint || 'default', properties: {} } });
  };
  const itemPayload = () => {
    const type = byId('item-type').value;
    const origin = byId('website').value.trim();
    const item = {
      type: type === 'integration' ? 'apiKey' : type,
      name: byId('name').value.trim(),
      username: byId('username').value,
      password: byId('item-password').value,
      notes: byId('notes').value,
      uris: origin ? [{ uri: origin }] : [],
      agentPolicy: { mode: byId('policy-mode').value, level: byId('policy-level').value, agents: entries(byId('policy-agents').value), sites: sites(byId('policy-sites').value), expiresAt: null, askFirst: byId('ask-first').checked, allowServerAgents: byId('allow-server-agents').checked },
    };
    if (type === 'integration') item.integration = { integrationId: byId('integration-id').value.trim(), accountId: byId('account-id').value.trim(), properties: readIntegrationProperties() };
    return item;
  };

  const start = async() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const grant = fragment.get('grant'); csrf = fragment.get('csrf') || '';
    history.replaceState(null, '', '/vault/');
    if (!grant || !csrf) throw new Error('Open the vault from Sulla Desktop to start a protected session');
    const session = await api('/v1/human/session/exchange', { method: 'POST', body: JSON.stringify({ grant, csrf }) });
    csrf = session.csrf; setPhase(session.phase);
    if (session.phase === 'unlocked') { await load(); await openIntegrationHint(); }
    else { byId('unlock-title').textContent = session.setupRequired ? 'Create your vault password' : 'Unlock your vault'; byId('password').autocomplete = session.setupRequired ? 'new-password' : 'current-password'; }
  };

  byId('unlock-form').onsubmit = async event => {
    event.preventDefault(); byId('unlock-error').textContent = '';
    try { const result = await api('/v1/human/unlock', { method: 'POST', body: JSON.stringify({ password: byId('password').value }) }); csrf = result.csrf; byId('password').value = ''; setPhase('unlocked'); await load(); await openIntegrationHint(); }
    catch (error) { byId('unlock-error').textContent = error.message; }
  };
  byId('recovery-unlock-form').onsubmit = async event => {
    event.preventDefault();
    try { const result = await api('/v1/human/recovery/unlock', { method: 'POST', body: JSON.stringify({ recoveryCode: byId('recovery-code').value.trim(), nextPassword: byId('recovery-password').value }) }); csrf = result.csrf; byId('recovery-unlock-form').reset(); setPhase('unlocked'); await load(); await openIntegrationHint(); }
    catch (error) { byId('unlock-error').textContent = error.message; }
  };
  byId('new-item').onclick = () => { void openEditor(null).catch(error => message(error.message, true)); };
  byId('item-type').onchange = () => { const integration = byId('item-type').value === 'integration'; byId('integration-fields').hidden = !integration; byId('item-secret-field').hidden = integration; if (integration && !byId('integration-properties').children.length) renderIntegrationProperties({}); };
  byId('add-integration-property').onclick = () => {
    const root = byId('integration-properties');
    if (root.children.length >= 20) return message('Integration properties are limited to 20.', true);
    const row = document.createElement('div'); row.className = 'property-row';
    const key = document.createElement('input'); key.className = 'integration-property-name'; key.placeholder = 'Property name'; key.autocomplete = 'off';
    const secret = document.createElement('input'); secret.className = 'integration-property-value'; secret.type = 'password'; secret.placeholder = 'Secret value'; secret.autocomplete = 'new-password';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove'; remove.onclick = () => row.remove();
    row.append(key, secret, remove); root.append(row); key.focus();
  };
  byId('cancel').onclick = () => byId('editor').close();
  byId('refresh').onclick = () => load().catch(error => message(error.message, true));
  byId('item-form').onsubmit = async event => {
    event.preventDefault(); const id = byId('item-id').value; const revision = Number(byId('revision').value || 0);
    try { await api(id ? `/v1/human/items/${encodeURIComponent(id)}` : '/v1/human/items', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(id ? { item: itemPayload(), revision } : { item: itemPayload() }) }); byId('item-password').value = ''; byId('editor').close(); await load(); message('Item saved.'); }
    catch (error) { message(error.message, true); }
  };
  byId('delete-item').onclick = async() => {
    const id = byId('item-id').value; if (!id || !confirm('Delete this vault item?')) return;
    try { await api(`/v1/human/items/${encodeURIComponent(id)}?revision=${encodeURIComponent(byId('revision').value)}`, { method: 'DELETE' }); byId('editor').close(); await load(); message('Item deleted.'); }
    catch (error) { message(error.message, true); }
  };
  byId('password-form').onsubmit = async event => {
    event.preventDefault(); try { const result = await api('/v1/human/password', { method: 'POST', body: JSON.stringify({ currentPassword: byId('current-password').value, nextPassword: byId('new-password').value }) }); if (result?.csrf) csrf = result.csrf; event.target.reset(); message('Password changed. Auto-unlock remains disabled; use the new password next start.'); } catch (error) { message(error.message, true); }
  };
  byId('recovery-form').onsubmit = async event => {
    event.preventDefault(); try { const bytes = crypto.getRandomValues(new Uint8Array(32)); const recoveryCode = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); bytes.fill(0); await api('/v1/human/recovery/configure', { method: 'POST', body: JSON.stringify({ recoveryCode }) }); event.target.reset(); byId('recovery-output').hidden = false; byId('recovery-output').textContent = recoveryCode; message('Recovery code generated. Save it now; it will not be shown again.'); } catch (error) { message(error.message, true); }
  };
  byId('backup-export-form').onsubmit = async event => {
    event.preventDefault(); try { const backup = await api('/v1/human/backup/export', { method: 'POST', body: JSON.stringify({ backupPassword: byId('backup-export-password').value }) }); const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `sulla-vault-backup-${new Date().toISOString().slice(0, 10)}.vault`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); event.target.reset(); message('Encrypted backup downloaded.'); } catch (error) { message(error.message, true); }
  };
  byId('backup-import-form').onsubmit = async event => {
    event.preventDefault(); try { const file = byId('backup-file').files[0]; if (file.size > 25 * 1024 * 1024) throw new Error('Backup files are limited to 25 MB'); const backup = JSON.parse(await file.text()); await api('/v1/human/backup/import', { method: 'POST', body: JSON.stringify({ backupPassword: byId('backup-import-password').value, backup }) }); event.target.reset(); byId('unlock-error').textContent = 'Backup restored. Unlock it with the vault password from that backup.'; } catch (error) { byId('unlock-error').textContent = error.message; }
  };
  byId('lock').onclick = async() => {
    try { const next = await api('/v1/human/lock', { method: 'POST', body: '{}' }); if (!next?.csrf || next.phase !== 'pre-unlock') throw new Error('Vault lock did not rotate the protected session'); csrf = next.csrf; items = []; renderItems(); if (byId('editor').open) byId('editor').close(); document.querySelectorAll('form').forEach(form => form.reset()); renderIntegrationProperties({}); byId('recovery-output').textContent = ''; byId('recovery-output').hidden = true; message(''); setPhase(next.phase); } catch (error) { message(error.message, true); }
  };
  for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach(value => value.classList.toggle('active', value === button));
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
  };
  addEventListener('pagehide', () => { csrf = ''; items = []; });
  start().catch(error => { byId('state').textContent = 'Unavailable'; byId('unlock').hidden = false; byId('unlock-error').textContent = error.message; });
})();
