(() => {
  'use strict';

  let csrf = '';
  let items = [];
  let selectedId = '';
  let category = 'all';
  let accessFilter = 'all';
  let query = '';
  let detailGeneration = 0;
  let editingItem = null;
  let auditGeneration = 0;
  let auditEvents = [];
  let auditOffset = 0;
  let auditActor = 'all';
  let auditHasMore = false;
  const initialUrl = new URL(location.href);
  const integrationHint = initialUrl.searchParams.get('integration');
  const accountHint = initialUrl.searchParams.get('account');
  const filesRestore = initialUrl.searchParams.get('restoreFiles') === '1';
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const defaultPolicy = () => ({ mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false });
  const policy = item => ({ ...defaultPolicy(), ...(item?.agentPolicy || {}) });
  const entries = value => value.split(',').map(entry => entry.trim()).filter(Boolean);
  const sites = value => entries(value).map(entry => entry.toLowerCase());
  // Two-letter tile initials as in the approved design: GitHub → GH, HubSpot → HS, Stripe secret key → ST.
  const initials = item => {
    const word = (item?.name || item?.integration?.integrationId || '').match(/[\p{L}\p{N}]+/u)?.[0] || '--';
    const inner = word.slice(1).match(/\p{Lu}/u)?.[0];
    return (word[0] + (inner || word[1] || '')).toUpperCase();
  };
  // Stable per-item tile tint (vault.css .tile, .tile.c2 … .tile.c5).
  const tileTint = item => { let hash = 0; for (const character of String(item?.id || item?.name || '')) hash = (hash * 31 + character.codePointAt(0)) >>> 0; return hash % 5 ? ` c${ hash % 5 + 1 }` : ''; };
  const levelBars = '<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>';
  const lockIcon = '<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>';
  const agentIcon = '<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="7" width="14" height="12" rx="3"></rect><path d="M9 4v3m6-3v3M8 12h.01M12 12h.01M16 12h.01M9 16h6"></path></svg>';
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
  const invalidateDetail = (clearSelection = true) => {
    detailGeneration += 1;
    editingItem = null;
    if (clearSelection) selectedId = '';
    byId('edit-item').onclick = null;
    byId('detail-fields').replaceChildren();
    byId('detail-activity').replaceChildren();
    byId('activity-count').textContent = '0';
    byId('detail-content').hidden = true;
    byId('detail-empty').hidden = false;
  };
  const invalidateAudit = () => {
    auditGeneration += 1;
    auditEvents = [];
    auditHasMore = false;
    byId('audit-rows').replaceChildren();
    byId('audit-detail').replaceChildren();
    byId('audit-total').textContent = byId('audit-agent-count').textContent = byId('audit-blocked-count').textContent = '0';
    byId('audit-prev').disabled = byId('audit-next').disabled = true;
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
      const tile = document.createElement('span'); tile.className = `tile${tileTint(item)}`; tile.textContent = initials(item);
      const meta = document.createElement('span'); meta.className = 'meta';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name || 'Untitled';
      const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = [item.username, item.uris?.[0]?.uri, typeLabel(item.type)].filter(Boolean).join(' · ');
      meta.append(name, sub);
      const summary = document.createElement('span'); summary.className = 'policy-summary';
      const level = document.createElement('span'); level.className = `lvl ${itemPolicy.level === 'full' ? 'l3' : itemPolicy.level === 'autofill' ? 'l2' : itemPolicy.mode === 'agents' ? 'l1' : ''}`; level.innerHTML = levelBars; level.append(itemPolicy.mode === 'agents' ? String(itemPolicy.level).toUpperCase() : 'NONE');
      const who = document.createElement('span'); who.className = `who ${itemPolicy.mode === 'agents' ? 'agents' : 'personal'}`; who.innerHTML = `${itemPolicy.mode === 'agents' ? agentIcon : lockIcon}${itemPolicy.mode === 'agents' ? 'Agents can use' : 'Only me'}`;
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
      const reveal = document.createElement('button'); reveal.type = 'button'; reveal.innerHTML = '<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>'; reveal.setAttribute('aria-label', 'Reveal'); reveal.title = 'Reveal'; let shown = false;
      reveal.onclick = () => { shown = !shown; output.textContent = shown ? value : '••••••••••••'; reveal.setAttribute('aria-label', shown ? 'Hide' : 'Reveal'); reveal.title = shown ? 'Hide' : 'Reveal'; if (shown) setTimeout(() => { shown = false; output.textContent = '••••••••••••'; reveal.setAttribute('aria-label', 'Reveal'); reveal.title = 'Reveal'; }, 30_000); };
      row.append(reveal);
    }
    return row;
  };

  // ── Custom fields ─────────────────────────────────────────────────────────
  // Types, limits and validators come from customFields.js (mirror of vault-crypto customFields.ts).
  const CF = globalThis.SullaVaultCustomFields;
  const icon = path => `<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24">${path}</svg>`;
  const eyePath = '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>';
  const copyPath = '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>';
  const iconButton = (path, label, className = '') => { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.innerHTML = icon(path); button.setAttribute('aria-label', label); button.title = label; return button; };
  const customFieldTypeName = type => CF.TYPE_LABELS[type] || `Other (${type})`;
  const copyValue = async value => { try { await navigator.clipboard.writeText(value); message('Copied.'); } catch { message('Copy is unavailable in this window.', true); } };
  const customFieldDetail = field => {
    const secret = CF.isSecret(field);
    const row = detailField(field.label, field.type === 'boolean' ? (field.value === 'true' ? 'Yes' : 'No') : field.value, secret);
    row.classList.add('custom-field-detail'); row.dataset.customType = field.type;
    const output = row.querySelector('.v');
    if (field.type === 'multiline' && !secret) output.classList.add('multiline');
    if (field.type === 'url' && field.value && !CF.valueError('url', field.value)) {
      const link = document.createElement('a'); link.href = field.value.trim(); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = field.value.trim();
      output.replaceChildren(link);
    }
    if (field.type === 'boolean') { output.classList.add('bool-value', field.value === 'true' ? 'yes' : 'no'); output.setAttribute('aria-label', `${field.label}: ${output.textContent}`); }
    if (field.value && field.type !== 'boolean') { const copy = iconButton(copyPath, `Copy ${field.label}`); copy.onclick = () => { void copyValue(field.value); }; row.append(copy); }
    return row;
  };

  const newFieldId = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  const customFieldRows = () => [...byId('custom-fields').querySelectorAll('.custom-field-row')];
  const updateCustomFieldCount = () => { const count = customFieldRows().length; byId('custom-field-count').textContent = count ? `${count} of ${CF.LIMITS.maxFields}` : ''; byId('add-custom-field').disabled = count >= CF.LIMITS.maxFields; };
  const rowValue = row => {
    const input = row.querySelector('.cf-input');
    if (!input) return '';
    return row.dataset.type === 'boolean' ? String(input.checked) : input.value;
  };
  // Builds the value control for a type. Secrets get a masked input plus a reveal button.
  const customFieldInput = (row, type, value) => {
    const holder = row.querySelector('.cf-value'); holder.replaceChildren();
    const labelText = () => row.querySelector('.cf-label').value.trim() || 'Custom field';
    let input;
    if (type === 'boolean') {
      const toggle = document.createElement('label'); toggle.className = 'cf-toggle';
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = value === 'true';
      const track = document.createElement('i'); track.setAttribute('aria-hidden', 'true');
      const state = document.createElement('span'); state.className = 'cf-toggle-text'; state.textContent = input.checked ? 'Yes' : 'No';
      input.addEventListener('change', () => { state.textContent = input.checked ? 'Yes' : 'No'; });
      toggle.append(input, track, state); holder.append(toggle);
    } else if (type === 'multiline') {
      input = document.createElement('textarea'); input.value = value; input.rows = 3; holder.append(input);
    } else {
      input = document.createElement('input'); input.value = value; input.autocomplete = 'off'; input.spellcheck = false;
      input.type = ({ password: 'password', 'one-time': 'password', url: 'url', email: 'email', date: 'date', phone: 'tel' })[type] || 'text';
      if (type === 'number') input.inputMode = 'decimal';
      if (CF.SECRET_TYPES.includes(type)) input.autocomplete = 'new-password';
      input.placeholder = ({ url: 'https://example.com', email: 'name@example.com', phone: '+1 555 0100', number: '0', 'one-time': 'Base32 secret or otpauth:// URI', password: 'Secret value' })[type] || 'Value';
      holder.append(input);
      if (CF.SECRET_TYPES.includes(type)) {
        const reveal = iconButton(eyePath, 'Reveal value', 'cf-icon');
        reveal.onclick = () => { const shown = input.type === 'password'; input.type = shown ? 'text' : 'password'; reveal.setAttribute('aria-label', shown ? 'Hide value' : 'Reveal value'); reveal.title = reveal.getAttribute('aria-label'); };
        holder.append(reveal);
      }
    }
    input.classList.add('cf-input');
    input.setAttribute('aria-label', `${labelText()} value`);
    input.addEventListener(type === 'boolean' ? 'change' : 'input', () => validateCustomFieldRow(row));
    holder.classList.toggle('with-action', CF.SECRET_TYPES.includes(type));
  };
  const setRowNote = (row, text, kind) => { const note = row.querySelector('.cf-note'); note.textContent = text || ''; note.className = `cf-note${kind ? ` ${kind}` : ''}`; };
  // Inline validation with the shared rules. Returns the first problem or null.
  const validateCustomFieldRow = (row, final = false) => {
    const label = row.querySelector('.cf-label').value;
    const others = customFieldRows().filter(other => other !== row).map(other => other.querySelector('.cf-label').value);
    const labelProblem = label.trim() || final ? CF.labelError(label, others) : null;
    const valueProblem = CF.valueError(row.dataset.type, rowValue(row));
    const problem = labelProblem || (valueProblem ? `Value ${valueProblem}` : null);
    row.classList.toggle('invalid', Boolean(problem));
    row.querySelector('.cf-label').setAttribute('aria-invalid', String(Boolean(labelProblem)));
    row.querySelector('.cf-input')?.setAttribute('aria-invalid', String(Boolean(valueProblem)));
    if (problem) setRowNote(row, problem, 'error'); else if (row.querySelector('.cf-note').classList.contains('error')) setRowNote(row, '');
    return problem;
  };
  const changeCustomFieldType = (row, nextType) => {
    const previousType = row.dataset.type; const previous = rowValue(row);
    let next = previous; let note = '';
    if (nextType === 'boolean') { if (!['true', 'false'].includes(previous)) { next = 'false'; if (previous) note = `Value cleared: it is not valid for ${customFieldTypeName(nextType)}.`; } }
    else if (previousType === 'boolean') next = '';
    else if (previous && CF.valueError(nextType, previous)) { next = ''; note = `Value cleared: it is not valid for ${customFieldTypeName(nextType)}.`; }
    row.dataset.type = nextType; customFieldInput(row, nextType, next);
    validateCustomFieldRow(row); if (note) setRowNote(row, note, 'warn');
  };
  const addCustomFieldRow = (field = {}) => {
    const root = byId('custom-fields'); const type = field.type || 'text';
    const row = document.createElement('div'); row.className = 'custom-field-row'; row.dataset.fieldId = field.id || newFieldId(); row.dataset.type = type;
    if (field.hidden !== undefined) row.dataset.hidden = String(field.hidden);
    const head = document.createElement('div'); head.className = 'cf-head';
    const label = document.createElement('input'); label.className = 'cf-label'; label.placeholder = 'Label'; label.maxLength = CF.LIMITS.maxLabelLength; label.value = field.label || ''; label.autocomplete = 'off'; label.setAttribute('aria-label', 'Custom field label');
    const select = document.createElement('select'); select.className = 'cf-type'; select.setAttribute('aria-label', 'Value type');
    for (const value of CF.isKnownType(type) ? CF.TYPES : [...CF.TYPES, type]) { const option = document.createElement('option'); option.value = value; option.textContent = customFieldTypeName(value); select.append(option); }
    select.value = type;
    select.onchange = () => changeCustomFieldType(row, select.value);
    const up = iconButton('<path d="m6 15 6-6 6 6"/>', 'Move field up', 'cf-icon'); up.onclick = () => { if (row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling); };
    const down = iconButton('<path d="m6 9 6 6 6-6"/>', 'Move field down', 'cf-icon'); down.onclick = () => { if (row.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row); };
    const remove = iconButton('<path d="M6 6l12 12M18 6 6 18"/>', 'Remove custom field', 'cf-icon cf-remove'); remove.onclick = () => { row.remove(); updateCustomFieldCount(); customFieldRows().forEach(other => validateCustomFieldRow(other)); };
    head.append(label, select, up, down, remove);
    const value = document.createElement('div'); value.className = 'cf-value';
    const note = document.createElement('p'); note.className = 'cf-note'; note.setAttribute('role', 'status');
    row.append(head, value, note); root.append(row);
    customFieldInput(row, type, typeof field.value === 'string' ? field.value : '');
    label.addEventListener('input', () => { row.querySelector('.cf-input')?.setAttribute('aria-label', `${label.value.trim() || 'Custom field'} value`); customFieldRows().forEach(other => validateCustomFieldRow(other)); });
    updateCustomFieldCount();
    return label;
  };
  const renderCustomFields = fields => { byId('custom-fields').replaceChildren(); for (const field of Array.isArray(fields) ? fields.slice(0, CF.LIMITS.maxFields) : []) addCustomFieldRow(field); updateCustomFieldCount(); };
  // Collects editor rows in display order and validates them with the shared rules (fails closed).
  const readCustomFields = () => {
    const rows = customFieldRows();
    const problems = rows.map(row => validateCustomFieldRow(row, true));
    const first = problems.findIndex(Boolean);
    if (first >= 0) { rows[first].querySelector('.cf-label').focus(); throw new Error(`Custom field ${first + 1}: ${problems[first]}`); }
    const fields = rows.map(row => ({ id: row.dataset.fieldId, label: row.querySelector('.cf-label').value.trim(), type: row.dataset.type, value: rowValue(row), ...(row.dataset.hidden ? { hidden: row.dataset.hidden === 'true' } : {}) }));
    const preserved = Array.isArray(editingItem?.customFields) ? editingItem.customFields : [];
    const checked = CF.validate(fields, { preserved });
    if (!checked.ok) throw new Error(checked.error);
    return checked.fields;
  };

  const selectItem = async id => {
    const generation = ++detailGeneration;
    selectedId = id; renderItems();
    editingItem = null;
    byId('detail-empty').hidden = true; byId('detail-content').hidden = false;
    try {
      const [revealed, activity] = await Promise.all([
        api(`/v1/human/items/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: '{}' }),
        api(`/v1/human/activity?item=${encodeURIComponent(id)}`),
      ]);
      if (generation !== detailGeneration || selectedId !== id) return;
      const item = { ...revealed.item, id: revealed.id, revision: revealed.revision };
      editingItem = JSON.parse(JSON.stringify(item));
      const itemPolicy = policy(item);
      byId('detail-tile').textContent = initials(item); byId('detail-tile').className = `tile xl${tileTint(item)}`; byId('detail-name').textContent = item.name || 'Untitled';
      byId('detail-meta').textContent = `${typeLabel(item.type)} · edited ${dateText(items.find(value => value.id === id)?.updatedAt)}`;
      const fields = byId('detail-fields'); fields.replaceChildren();
      if (item.username) fields.append(detailField('Username', item.username));
      if (item.password) fields.append(detailField(item.type === 'apiKey' ? 'Secret' : 'Password', item.password, true));
      for (const [name, value] of Object.entries(item.integration?.properties || {})) fields.append(detailField(name, value, true));
      if (item.uris?.[0]?.uri) fields.append(detailField('Website', item.uris[0].uri));
      for (const field of Array.isArray(item.customFields) ? item.customFields : []) if (field && typeof field.label === 'string') fields.append(customFieldDetail({ ...field, value: typeof field.value === 'string' ? field.value : '' }));
      if (item.notes) fields.append(detailField('Notes', item.notes));
      if (item.proxy) { fields.append(detailField('Agent usage hosts', item.proxy.hosts.join(', '))); for (const rule of item.proxy.rules) fields.append(detailField(`Usage: ${rule.target} ${rule.name}`, `${rule.scheme} from ${rule.scheme === 'Basic' ? 'username:password' : rule.source}`)); }
      if (!fields.children.length) fields.append(detailField('Details', 'No additional fields'));
      const enabled = itemPolicy.mode === 'agents';
      byId('detail-access-title').textContent = enabled ? 'Agents can use this' : 'Only you can use this';
      byId('detail-access-copy').textContent = enabled ? (itemPolicy.level === 'autofill' ? 'Sulla can use it without revealing the secret.' : `Agents have ${itemPolicy.level} access.`) : 'Agents cannot use this item.';
      [...byId('detail-ladder').children].forEach((node, index) => node.classList.toggle('on', index === (enabled ? { metadata: 1, autofill: 2, full: 3 }[itemPolicy.level] : 0)));
      byId('detail-sites').textContent = itemPolicy.sites.length ? itemPolicy.sites.join(', ') : 'Any registered destination';
      byId('detail-expiry').textContent = dateText(itemPolicy.expiresAt); byId('detail-ask').textContent = itemPolicy.askFirst ? 'Every use' : 'No';
      const events = activity.events || []; byId('activity-count').textContent = String(events.length);
      byId('detail-activity').innerHTML = events.length ? events.slice(0, 6).map(event => `<div class="activity-event"><b>${esc(auditAction(event))}</b><span>${esc(dateText(event.created_at))}</span><span>${esc(auditIsAgent(event) ? event.metadata?.agentId || 'Agent' : 'You')}</span><span>${esc(auditResult(event))}</span></div>`).join('') : '<div class="honest-state">No recorded activity for this item.</div>';
      byId('edit-item').onclick = () => { void openEditor(item); };
    } catch (error) {
      if (generation !== detailGeneration || selectedId !== id) return;
      invalidateDetail(false);
      message(error.message, true);
    }
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
  const showBrowser = () => { auditGeneration += 1; byId('editor-view').hidden = true; byId('audit-view').hidden = true; byId('browser-view').hidden = false; byId('nav-audit').classList.remove('on'); document.querySelectorAll('[data-category]').forEach(button => button.classList.toggle('on', button.dataset.category === category)); };
  const renderProxyRules = rules => {
    const container = byId('proxy-rules'); container.replaceChildren();
    for (const rule of rules || []) {
      const row = document.createElement('div'); row.className = 'proxy-rule form-grid';
      row.innerHTML = `<label>Source<input class="proxy-source" placeholder="password, username, custom:Label"></label><label>Target<select class="proxy-target"><option value="header">Header</option><option value="query">Query</option></select></label><label>Name<input class="proxy-name" maxlength="64"></label><label>Scheme<select class="proxy-scheme"><option>raw</option><option>Bearer</option><option>Token</option><option>Basic</option></select></label><button type="button" class="btn sm">Remove rule</button>`;
      row.querySelector('.proxy-source').value = rule.source || 'password'; row.querySelector('.proxy-target').value = rule.target || 'header'; row.querySelector('.proxy-name').value = rule.name || ''; row.querySelector('.proxy-scheme').value = rule.scheme || 'raw';
      row.querySelector('button').onclick = () => row.remove(); container.append(row);
    }
  };
  const readProxyRules = () => [...byId('proxy-rules').children].map(row => ({ source: row.querySelector('.proxy-source').value.trim(), target: row.querySelector('.proxy-target').value, name: row.querySelector('.proxy-name').value.trim(), scheme: row.querySelector('.proxy-scheme').value }));
  const syncProxyFields = () => { byId('proxy-fields').hidden = !['apiKey', 'login'].includes(byId('item-type').value); };
  byId('add-proxy-rule').onclick = () => { const rules = readProxyRules(); if (rules.length >= 5) return message('At most five usage rules.', true); renderProxyRules([...rules, { source: 'password', target: 'header', name: 'X-API-Key', scheme: 'raw' }]); };
  byId('proxy-presets').onclick = event => {
    const preset = event.target.closest('[data-proxy]')?.dataset.proxy; if (!preset) return;
    const rule = (name, scheme = 'raw', source = 'password', target = 'header') => ({ source, target, name, scheme });
    const presets = { bearer: [rule('Authorization', 'Bearer')], key: [rule('X-API-Key')], cloudflare: [rule('Authorization', 'Bearer')], global: [rule('X-Auth-Key'), rule('X-Auth-Email', 'raw', 'username')], basic: [rule('Authorization', 'Basic')], query: [rule('api_key', 'raw', 'password', 'query')] };
    if (['cloudflare', 'global'].includes(preset)) byId('proxy-hosts').value = 'api.cloudflare.com';
    byId('proxy-hint').textContent = preset === 'global' ? 'put your Cloudflare login email in Username' : '';
    renderProxyRules(presets[preset]);
  };
  const openEditor = async item => {
    const generation = ++detailGeneration;
    byId('item-form').reset(); let detail = item;
    if (item?.id && !item.password && !item.integration?.properties) {
      const revealed = await api(`/v1/human/items/${encodeURIComponent(item.id)}/reveal`, { method: 'POST', body: '{}' });
      if (generation !== detailGeneration) return;
      detail = { ...revealed.item, id: revealed.id, revision: revealed.revision };
    }
    editingItem = detail ? JSON.parse(JSON.stringify(detail)) : null;
    byId('proxy-hosts').value = detail?.proxy?.hosts?.join(', ') || ''; renderProxyRules(detail?.proxy?.rules); byId('proxy-hint').textContent = '';
    const itemPolicy = policy(detail);
    byId('item-id').value = detail?.id || ''; byId('revision').value = detail?.revision || ''; byId('item-type').value = detail?.integration ? 'integration' : detail?.type || 'login';
    byId('name').value = detail?.name || ''; byId('username').value = detail?.username || detail?.integration?.accountId || ''; byId('item-password').value = detail?.password || ''; byId('website').value = detail?.uris?.[0]?.uri || ''; byId('notes').value = detail?.notes || ''; byId('favorite').checked = Boolean(detail?.favorite);
    byId('integration-id').value = detail?.integration?.integrationId || ''; byId('account-id').value = detail?.integration?.accountId || ''; renderIntegrationProperties(detail?.integration?.properties); renderCustomFields(detail?.customFields);
    const agentsEnabled = itemPolicy.mode === 'agents'; byId('agent-enabled').checked = agentsEnabled; byId('only-me-access').checked = !agentsEnabled; setPolicyLevel(itemPolicy.level); byId('ask-first').checked = Boolean(itemPolicy.askFirst); byId('allow-server-agents').checked = Boolean(itemPolicy.allowServerAgents); byId('policy-sites').value = itemPolicy.sites.join(', '); byId('policy-expiry').value = localDateValue(itemPolicy.expiresAt); syncPolicyEnabled();
    const integration = byId('item-type').value === 'integration'; byId('integration-fields').hidden = !integration; byId('item-secret-field').hidden = integration;
    syncProxyFields();
    byId('delete-item').hidden = !detail?.id; byId('editor-title').textContent = detail?.id ? `Edit ${detail.name}` : 'New vault item'; byId('editor-crumb').textContent = detail?.name || 'New item'; byId('editor-tile').textContent = initials(detail) || '＋';
    byId('browser-view').hidden = true; byId('editor-view').hidden = false; byId('name').focus();
  };
  const itemPayload = () => {
    const type = byId('item-type').value; const origin = byId('website').value.trim(); const expiry = byId('policy-expiry').value;
    const item = editingItem ? JSON.parse(JSON.stringify(editingItem)) : {};
    delete item.id; delete item.revision;
    const existingUris = Array.isArray(item.uris) ? item.uris : [];
    item.type = type === 'integration' ? 'apiKey' : type;
    item.name = byId('name').value.trim(); item.favorite = byId('favorite').checked;
    item.username = byId('username').value; item.password = byId('item-password').value; item.notes = byId('notes').value;
    item.uris = origin ? [{ ...(existingUris[0] || {}), uri: origin }, ...existingUris.slice(1)] : existingUris.slice(1);
    item.agentPolicy = { mode: byId('policy-mode').value, level: byId('policy-level').value, agents: [], sites: sites(byId('policy-sites').value), expiresAt: expiry ? new Date(expiry).toISOString() : null, askFirst: byId('ask-first').checked, allowServerAgents: byId('allow-server-agents').checked };
    if (type === 'integration') item.integration = { ...(item.integration || {}), integrationId: byId('integration-id').value.trim(), accountId: byId('account-id').value.trim(), properties: readIntegrationProperties() };
    else delete item.integration;
    const customFields = readCustomFields();
    if (customFields.length) item.customFields = customFields; else delete item.customFields;
    if (['apiKey', 'login'].includes(type)) {
      const hosts = entries(byId('proxy-hosts').value); const rules = readProxyRules();
      if (hosts.length || rules.length) item.proxy = { hosts, rules }; else delete item.proxy;
    }
    return item;
  };
  const openIntegrationHint = async() => {
    if (!integrationHint) return;
    if (accountHint) for (const item of items.slice(0, 200)) { const revealed = await api(`/v1/human/items/${encodeURIComponent(item.id)}/reveal`, { method: 'POST', body: '{}' }); if (revealed.item?.integration?.integrationId === integrationHint && revealed.item?.integration?.accountId === accountHint) { await openEditor({ ...revealed.item, id: revealed.id, revision: revealed.revision }); return; } }
    await openEditor({ type: 'apiKey', name: integrationHint, integration: { integrationId: integrationHint, accountId: accountHint || 'default', properties: {} } });
  };

  const auditIsAgent = event => Boolean(event.metadata?.agentId) || ['vault_outbound_request', 'agent_credential_broker_use', 'agent_credential_use'].includes(event.action);
  const auditAction = event => event.blocked && ['vault_outbound_request', 'agent_credential_broker_use', 'agent_credential_use'].includes(event.action)
    ? 'Attempted credential use' : ({
    human_item_reveal: 'Revealed item', human_item_created: 'Created item', human_item_updated: 'Changed item', human_item_deleted: 'Deleted item',
    vault_outbound_request: 'Used credential', agent_credential_broker_use: 'Used credential', agent_credential_use: 'Used credential',
  })[event.action] || String(event.action || 'Recorded action').replaceAll('_', ' ');
  const auditItem = event => items.find(item => item.id === event.item_id)?.name || (event.item_id ? 'Deleted or unavailable item' : 'Vault');
  const auditWhere = event => event.metadata?.destination || event.metadata?.operation || event.pod_id || 'Desktop vault';
  const auditResult = event => event.blocked ? 'Blocked' : (auditIsAgent(event) ? 'Allowed' : 'Recorded');
  const renderAuditDetail = index => {
    const event = auditEvents[index];
    if (!event) { byId('audit-detail').innerHTML = '<div class="empty-state"><b>Select an event</b><span>Authorized metadata will appear here.</span></div>'; return; }
    document.querySelectorAll('[data-audit-event]').forEach((row, rowIndex) => row.classList.toggle('selected', rowIndex === index));
    const agent = auditIsAgent(event);
    byId('audit-detail').innerHTML = `<span class="audit-result ${event.blocked ? 'blocked' : ''}">${esc(auditResult(event))}</span><h2>${esc(auditAction(event))}</h2>${event.blocked ? `<div class="reason">${esc(event.reason || 'The action was denied before a secret was released.')}</div>` : ''}<div class="kv"><span>Who</span><b>${esc(agent ? event.metadata?.agentId || 'Agent' : 'You')}</b></div><div class="kv"><span>Item</span><b>${esc(auditItem(event))}</b></div><div class="kv"><span>Where</span><b>${esc(auditWhere(event))}</b></div><div class="kv"><span>Pod</span><b>${esc(event.pod_id || '—')}</b></div><div class="kv"><span>When</span><b>${esc(dateText(event.created_at))}</b></div><p class="security-note">This event contains authorized audit metadata only. No secret value is returned.</p>`;
  };
  const renderAudit = () => {
    byId('audit-total').textContent = String(auditEvents.length);
    byId('audit-agent-count').textContent = String(auditEvents.filter(auditIsAgent).length);
    byId('audit-blocked-count').textContent = String(auditEvents.filter(event => event.blocked).length);
    byId('audit-page').textContent = `Page ${Math.floor(auditOffset / 25) + 1}`;
    byId('audit-prev').disabled = auditOffset === 0; byId('audit-next').disabled = !auditHasMore;
    byId('audit-rows').innerHTML = auditEvents.length ? auditEvents.map((event, index) => { const agent = auditIsAgent(event); const who = agent ? event.metadata?.agentId || 'Agent' : 'You'; return `<tr data-audit-event="${index}"><td>${esc(dateText(event.created_at))}</td><td><span class="actor-cell"><span class="avatar ${agent ? 'agent' : ''}">${agent ? agentIcon : esc(who)}</span>${esc(who)}</span></td><td>${esc(auditAction(event))}</td><td>${esc(auditItem(event))}</td><td>${esc(auditWhere(event))}</td><td><span class="audit-result ${event.blocked ? 'blocked' : ''}">${esc(auditResult(event))}</span></td></tr>`; }).join('') : '<tr><td colspan="6" class="muted">No recorded events match these filters.</td></tr>';
    document.querySelectorAll('[data-audit-event]').forEach(row => row.onclick = () => renderAuditDetail(Number(row.dataset.auditEvent)));
    renderAuditDetail(auditEvents.length ? 0 : -1);
  };
  const loadAudit = async() => {
    const generation = ++auditGeneration;
    byId('audit-rows').innerHTML = '<tr><td colspan="6" class="muted">Loading authorized audit events…</td></tr>';
    const params = new URLSearchParams({ limit: '25', offset: String(auditOffset) });
    if (auditActor === 'human' || auditActor === 'agent') params.set('actor', auditActor);
    if (auditActor === 'blocked') params.set('blocked', 'true');
    const range = byId('audit-time').value;
    if (range !== 'all') params.set('from', new Date(Date.now() - ({ '24h': 1, '7d': 7, '30d': 30 }[range] || 7) * 86_400_000).toISOString());
    const search = byId('audit-search').value.trim(); if (search) params.set('query', search);
    try {
      const result = await api(`/v1/human/activity?${params}`);
      if (generation !== auditGeneration || byId('audit-view').hidden) return;
      auditEvents = result.events || []; auditHasMore = Boolean(result.hasMore); renderAudit();
    } catch (error) {
      if (generation !== auditGeneration || byId('audit-view').hidden) return;
      auditEvents = []; auditHasMore = false; byId('audit-total').textContent = byId('audit-agent-count').textContent = byId('audit-blocked-count').textContent = '—';
      byId('audit-rows').innerHTML = `<tr class="audit-error"><td colspan="6">${esc(error.message)}</td></tr>`; byId('audit-prev').disabled = byId('audit-next').disabled = true;
      byId('audit-detail').innerHTML = '<div class="empty-state"><b>Audit events unavailable</b><span>The request failed; this is not an empty audit log.</span></div>';
    }
  };
  const showAudit = () => {
    invalidateDetail(); auditOffset = 0; byId('editor-view').hidden = true; byId('browser-view').hidden = true; byId('audit-view').hidden = false;
    document.querySelectorAll('[data-category]').forEach(button => button.classList.remove('on')); byId('nav-audit').classList.add('on'); void loadAudit();
  };

  const start = async() => {
    const fragment = new URLSearchParams(location.hash.slice(1)); const grant = fragment.get('grant'); csrf = fragment.get('csrf') || ''; history.replaceState(null, '', '/vault/');
    if (!csrf) throw new Error('Open the vault from Sulla Desktop to start a protected session');
    const session = grant ? await api('/v1/human/session/exchange', { method: 'POST', body: JSON.stringify({ grant, csrf }) }) : await api('/v1/human/session');
    csrf = session.csrf;
    if (filesRestore) {
      byId('unlock').hidden = true; byId('vault').hidden = true; byId('cloud-restore').hidden = false;
      return;
    }
    setPhase(session.phase);
    if (session.phase === 'unlocked') { await load(); await openIntegrationHint(); } else { byId('unlock-title').textContent = session.setupRequired ? 'Create your vault password' : 'Unlock your vault'; byId('password').autocomplete = session.setupRequired ? 'new-password' : 'current-password'; }
  };

  byId('cloud-restore-form').onsubmit = async event => { event.preventDefault(); const password = byId('cloud-restore-password'); byId('cloud-restore-error').textContent = ''; byId('cloud-restore-status').textContent = 'Checking encrypted Cloud vault…'; try { await api('/v1/human/files/cloud-escrow/unlock', { method: 'POST', body: JSON.stringify({ password: password.value }) }); password.value = ''; byId('cloud-restore-status').textContent = 'Cloud vault unlocked. Return to Files and continue the restore.'; } catch (error) { password.value = ''; byId('cloud-restore-status').textContent = ''; byId('cloud-restore-error').textContent = error.message; } };

  byId('unlock-form').onsubmit = async event => { event.preventDefault(); byId('unlock-error').textContent = ''; try { const result = await api('/v1/human/unlock', { method: 'POST', body: JSON.stringify({ password: byId('password').value }) }); csrf = result.csrf; byId('password').value = ''; setPhase('unlocked'); await load(); await openIntegrationHint(); } catch (error) { byId('unlock-error').textContent = error.message; } };
  byId('recovery-unlock-form').onsubmit = async event => { event.preventDefault(); try { const result = await api('/v1/human/recovery/unlock', { method: 'POST', body: JSON.stringify({ recoveryCode: byId('recovery-code').value.trim(), nextPassword: byId('recovery-password').value }) }); csrf = result.csrf; event.target.reset(); setPhase('unlocked'); await load(); await openIntegrationHint(); } catch (error) { byId('unlock-error').textContent = error.message; } };
  byId('new-item').onclick = () => { void openEditor(null).catch(error => message(error.message, true)); };
  byId('nav-audit').onclick = showAudit;
  byId('audit-back').onclick = showBrowser;
  document.querySelectorAll('[data-audit-actor]').forEach(button => button.onclick = () => { auditActor = button.dataset.auditActor; auditOffset = 0; document.querySelectorAll('[data-audit-actor]').forEach(value => value.classList.toggle('on', value === button)); void loadAudit(); });
  byId('audit-time').onchange = () => { auditOffset = 0; void loadAudit(); };
  byId('audit-search').onchange = () => { auditOffset = 0; void loadAudit(); };
  byId('audit-prev').onclick = () => { auditOffset = Math.max(0, auditOffset - 25); void loadAudit(); };
  byId('audit-next').onclick = () => { if (auditHasMore) { auditOffset += 25; void loadAudit(); } };
  byId('item-type').onchange = () => { syncProxyFields(); const integration = byId('item-type').value === 'integration'; byId('integration-fields').hidden = !integration; byId('item-secret-field').hidden = integration; if (integration && !byId('integration-properties').children.length) renderIntegrationProperties({}); };
  byId('add-integration-property').onclick = () => { if (byId('integration-properties').children.length >= 20) return message('Integration properties are limited to 20.', true); addPropertyRow().focus(); };
  byId('add-custom-field').onclick = () => { if (customFieldRows().length >= CF.LIMITS.maxFields) return message(`Custom fields are limited to ${CF.LIMITS.maxFields}.`, true); addCustomFieldRow().focus(); };
  document.querySelectorAll('input[name="policy-access"]').forEach(input => { input.onchange = syncPolicyEnabled; });
  document.querySelectorAll('[data-level]').forEach(button => button.onclick = () => setPolicyLevel(button.dataset.level));
  for (const id of ['cancel', 'editor-back']) byId(id).onclick = showBrowser;
  byId('search').oninput = event => { query = event.target.value.trim().toLowerCase(); renderItems(); };
  addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); byId('search').focus(); } });
  document.querySelectorAll('[data-category]').forEach(button => button.onclick = () => { showBrowser(); category = button.dataset.category; document.querySelectorAll('[data-category]').forEach(value => value.classList.toggle('on', value === button)); renderItems(); });
  document.querySelectorAll('[data-access]').forEach(button => button.onclick = () => { accessFilter = button.dataset.access; document.querySelectorAll('[data-access]').forEach(value => value.classList.toggle('on', value === button)); renderItems(); });
  document.querySelectorAll('[data-panel-open]').forEach(button => button.onclick = () => { const panel = button.dataset.panelOpen; byId('utility-title').textContent = panel === 'security' ? 'Security & recovery' : 'Encrypted backup'; document.querySelectorAll('[data-utility]').forEach(value => { value.hidden = value.dataset.utility !== panel; }); byId('utility-dialog').showModal(); });
  byId('utility-close').onclick = () => byId('utility-dialog').close();
  byId('item-form').onsubmit = async event => { event.preventDefault(); const id = byId('item-id').value; const revision = Number(byId('revision').value || 0); try { const result = await api(id ? `/v1/human/items/${encodeURIComponent(id)}` : '/v1/human/items', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(id ? { item: itemPayload(), revision } : { item: itemPayload() }) }); byId('item-password').value = ''; selectedId = result.id; await load(); showBrowser(); message('Item saved.'); } catch (error) { message(error.message, true); } };
  byId('delete-item').onclick = async() => { const id = byId('item-id').value; if (!id || !confirm('Delete this vault item?')) return; try { await api(`/v1/human/items/${encodeURIComponent(id)}?revision=${encodeURIComponent(byId('revision').value)}`, { method: 'DELETE' }); selectedId = ''; await load(); showBrowser(); byId('detail-content').hidden = true; byId('detail-empty').hidden = false; message('Item deleted.'); } catch (error) { message(error.message, true); } };
  byId('password-form').onsubmit = async event => { event.preventDefault(); try { const result = await api('/v1/human/password', { method: 'POST', body: JSON.stringify({ currentPassword: byId('current-password').value, nextPassword: byId('new-password').value }) }); if (result?.csrf) csrf = result.csrf; event.target.reset(); message('Password changed. Use the new password next start.'); } catch (error) { message(error.message, true); } };
  byId('recovery-form').onsubmit = async event => { event.preventDefault(); try { const bytes = crypto.getRandomValues(new Uint8Array(32)); const recoveryCode = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); bytes.fill(0); await api('/v1/human/recovery/configure', { method: 'POST', body: JSON.stringify({ recoveryCode }) }); event.target.reset(); byId('recovery-output').hidden = false; byId('recovery-output').textContent = recoveryCode; message('Recovery code generated. Save it now; it will not be shown again.'); } catch (error) { message(error.message, true); } };
  byId('backup-export-form').onsubmit = async event => { event.preventDefault(); try { const backup = await api('/v1/human/backup/export', { method: 'POST', body: JSON.stringify({ backupPassword: byId('backup-export-password').value }) }); const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `sulla-vault-backup-${new Date().toISOString().slice(0, 10)}.vault`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); event.target.reset(); message('Encrypted backup downloaded.'); } catch (error) { message(error.message, true); } };
  byId('backup-import-form').onsubmit = async event => { event.preventDefault(); try { const file = byId('backup-file').files[0]; if (file.size > 25 * 1024 * 1024) throw new Error('Backup files are limited to 25 MB'); const backup = JSON.parse(await file.text()); await api('/v1/human/backup/import', { method: 'POST', body: JSON.stringify({ backupPassword: byId('backup-import-password').value, backup }) }); event.target.reset(); byId('unlock-error').textContent = 'Backup restored. Unlock it with the vault password from that backup.'; } catch (error) { byId('unlock-error').textContent = error.message; } };
  byId('lock').onclick = async() => { try { invalidateDetail(); invalidateAudit(); const next = await api('/v1/human/lock', { method: 'POST', body: '{}' }); if (!next?.csrf || next.phase !== 'pre-unlock') throw new Error('Vault lock did not rotate the protected session'); csrf = next.csrf; items = []; renderItems(); showBrowser(); document.querySelectorAll('form').forEach(form => form.reset()); renderIntegrationProperties({}); renderCustomFields([]); byId('recovery-output').textContent = ''; byId('recovery-output').hidden = true; message(''); setPhase(next.phase); } catch (error) { message(error.message, true); } };
  addEventListener('pagehide', () => { invalidateDetail(); invalidateAudit(); csrf = ''; items = []; });
  start().catch(error => { byId('state').textContent = 'Unavailable'; byId('unlock').hidden = false; byId('unlock-error').textContent = error.message; });
})();
