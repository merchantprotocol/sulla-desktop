(() => {
  const service = 'vault';
  const api = window.location.pathname.startsWith('/services/vault/') ? '/services/vault/api/metadata/audit' : '/v1/metadata/audit';
  const state = { token: '', organizationId: '', events: [], offset: 0 };
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[character]));
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const shortId = value => value ? `${String(value).slice(0, 8)}…` : '—';
  const actionLabel = value => String(value ?? 'event').replaceAll('_', ' ');
  const actor = event => event.metadata?.agentName || event.metadata?.agentId || (event.pod_id ? 'Agent' : 'Member');
  const target = event => event.item_id ? `Item ${shortId(event.item_id)}` : event.collection_id ? `Collection ${shortId(event.collection_id)}` : 'Organization';
  const notice = message => { $('notice').textContent = message; $('notice').hidden = !message; };

  function parameters() {
    const values = { person:$('person').value.trim(), collection:$('collection').value.trim(), item:$('item').value.trim() };
    for (const [name, value] of Object.entries(values)) if (value && !uuid(value)) throw new Error(`${name[0].toUpperCase()}${name.slice(1)} ID must be a UUID.`);
    const from = $('from').value; const to = $('to').value;
    if (from && to && from > to) throw new Error('From date must be before the through date.');
    const query = new URLSearchParams({ limit:'50', offset:String(state.offset) });
    for (const [name, value] of Object.entries(values)) if (value) query.set(name, value);
    if ($('action').value.trim()) query.set('action', $('action').value.trim());
    if (from) query.set('from', new Date(`${from}T00:00:00Z`).toISOString());
    if (to) query.set('to', new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000).toISOString());
    if ($('blocked-only').checked) query.set('blocked', 'true');
    return query;
  }

  async function load() {
    if (!state.token) return;
    notice(''); $('events').innerHTML = '<tr><td colspan="6">Loading events…</td></tr>';
    const response = await fetch(`${api}?${parameters()}`, { headers:{ Authorization:`Bearer ${state.token}` }, cache:'no-store' });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) window.parent.postMessage({ type:'sulla.service.expired', version:1, service }, window.location.origin);
      throw new Error(response.status === 401 ? 'Your Accounts session expired.' : response.status === 403 ? 'This account cannot view the audit log.' : 'Audit events are unavailable.');
    }
    const result = await response.json();
    state.events = Array.isArray(result.events) ? result.events : [];
    $('total').textContent = String(result.summary?.total ?? 0); $('agents').textContent = String(result.summary?.agents ?? 0); $('blocked').textContent = String(result.summary?.blocked ?? 0);
    $('page').textContent = `Page ${Math.floor(state.offset / 50) + 1}`; $('previous').disabled = state.offset === 0; $('next').disabled = state.events.length < 50;
    $('events').innerHTML = state.events.length ? state.events.map((event, index) => `<tr data-event="${index}" tabindex="0"><td>${escapeHtml(new Date(event.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }))}</td><td><span class="actor"><span class="avatar">${event.pod_id ? '◆' : '●'}</span>${escapeHtml(actor(event))}</span></td><td>${escapeHtml(actionLabel(event.action))}</td><td>${escapeHtml(target(event))}</td><td class="where">${escapeHtml(event.metadata?.toolName || shortId(event.pod_id))}</td><td><span class="result${event.blocked ? ' bad' : ''}">${event.blocked ? 'Blocked' : 'Allowed'}</span></td></tr>`).join('') : '<tr><td colspan="6">No events match these filters.</td></tr>';
    document.querySelectorAll('[data-event]').forEach(row => { row.onclick = () => detail(Number(row.dataset.event)); row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); } }; });
    $('detail').innerHTML = '<p class="muted">Select an event to see its metadata.</p>';
    if (state.events[0]) detail(0);
    window.parent.postMessage({ type:'sulla.service.activity', version:1, service }, window.location.origin);
  }

  function detail(index) {
    const event = state.events[index]; if (!event) return;
    document.querySelectorAll('[data-event]').forEach((row, rowIndex) => row.classList.toggle('selected', rowIndex === index));
    const rows = [['Actor', actor(event)], ['Action', actionLabel(event.action)], ['Item', event.item_id || '—'], ['Collection', event.collection_id || '—'], ['Device', event.device_id || '—'], ['Pod', event.pod_id || '—'], ['When', new Date(event.created_at).toLocaleString()]];
    $('detail').innerHTML = `<span class="result${event.blocked ? ' bad' : ''}">${event.blocked ? 'Blocked' : 'Allowed'}</span><h2>${escapeHtml(actionLabel(event.action))}</h2>${event.blocked ? `<p class="why">${escapeHtml(event.reason || 'The request was denied before a secret was unlocked.')}</p>` : ''}${rows.map(([key,value]) => `<div class="kv"><span>${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`).join('')}<p class="security">✓ This record contains authorization metadata only. No secret value or decryption key is loaded by this page.</p>`;
  }

  function lock(message = 'Open Audit Log from the main console to authorize it with Accounts.') {
    state.token = ''; state.organizationId = ''; state.events = []; $('content').hidden = true; $('signed-out').hidden = false; $('signed-out').querySelector('p').textContent = message;
  }
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.version !== 1 || message.service !== service) return;
    if (message.type === 'sulla.service.lock') return lock();
    if (message.type !== 'sulla.service.session' || typeof message.token !== 'string' || typeof message.organizationId !== 'string') return;
    if (state.organizationId && state.organizationId !== message.organizationId) state.events = [];
    state.token = message.token; state.organizationId = message.organizationId; $('signed-out').hidden = true; $('content').hidden = false;
    void load().catch(error => notice(error instanceof Error ? error.message : 'Audit events are unavailable.'));
  });
  $('refresh').onclick = () => void load().catch(error => notice(error.message)); $('apply').onclick = () => { state.offset = 0; void load().catch(error => notice(error.message)); };
  $('previous').onclick = () => { state.offset = Math.max(0, state.offset - 50); void load().catch(error => notice(error.message)); };
  $('next').onclick = () => { if (state.events.length === 50) state.offset += 50; void load().catch(error => notice(error.message)); };
  window.parent.postMessage({ type:'sulla.service.ready', version:1, service }, window.location.origin);
})();
