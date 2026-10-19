(() => {
  const api = window.location.pathname.startsWith('/services/accounts/') ? '/accounts-api/v1/web' : '/v1/web';
  const state = { session: null, organizationId: '', serviceToken: '' };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const csrf = () => document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('sulla-console-csrf='))?.split('=').slice(1).join('=') ? decodeURIComponent(document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('sulla-console-csrf=')).split('=').slice(1).join('=')) : '';
  const notice = (message, error = false) => { const element = $('#notice'); element.textContent = message; element.className = `notice${error ? ' error' : ''}`; element.hidden = !message; };

  async function request(path, options = {}) {
    const response = await fetch(`${api}${path}`, {
      credentials: 'include', ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.method && options.method !== 'GET' ? { 'x-sulla-csrf': csrf() } : {}), ...options.headers },
    });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status})`); }
    return response.status === 204 ? null : response.json();
  }

  function sendReady() {
    if (window.parent !== window) window.parent.postMessage({ type: 'sulla.service.ready', version: 1, service: 'accounts' }, window.location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== window.location.origin || !event.data || event.data.version !== 1 || event.data.service !== 'accounts') return;
    if (event.data.type === 'sulla.service.session' && typeof event.data.token === 'string' && typeof event.data.expiresAt === 'string') {
      state.serviceToken = event.data.token;
      if (typeof event.data.organizationId === 'string') { state.organizationId = event.data.organizationId; $('#organization-select').value = state.organizationId; void loadUsers(); }
    }
    if (event.data.type === 'sulla.service.lock') {
      state.serviceToken = '';
      $('#users').replaceChildren();
      notice('Session locked. Return to the main console to unlock.', true);
    }
  });

  async function loadSession() {
    try {
      state.session = await request('/session');
      $('#session-label').textContent = `${state.session.organizations.length} organization${state.session.organizations.length === 1 ? '' : 's'}`;
      $('#signed-out').hidden = true;
      const select = $('#organization-select');
      select.innerHTML = state.session.organizations.map(org => `<option value="${escapeHtml(org.id)}">${escapeHtml(org.name)}</option>`).join('');
      state.organizationId = state.organizationId || state.session.organizations[0]?.id || '';
      select.value = state.organizationId;
      renderOrganizations(state.session.organizations);
      if (state.organizationId) await loadUsers(); else $('#users-empty').hidden = false;
    } catch (error) {
      $('#users-view').hidden = true; $('#organizations-view').hidden = true; $('#signed-out').hidden = false;
      $('#session-label').textContent = 'Signed out';
    }
  }

  async function loadUsers() {
    if (!state.organizationId) return;
    try {
      const result = await request(`/users?organizationId=${encodeURIComponent(state.organizationId)}`);
      const rows = result.users.filter(user => user.membership);
      $('#users-empty').hidden = rows.length > 0;
      $('#users').innerHTML = rows.map(user => `<tr><td><strong>${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username)}</strong><small>${escapeHtml(user.email || user.username)}</small></td><td><span class="pill${user.enabled ? '' : ' disabled'}">${user.enabled ? 'Active' : 'Disabled'}</span></td><td>${user.membership.roles.map(role => `<span class="pill">${escapeHtml(role)}</span>`).join('')}</td><td>${user.membership.groups.map(group => `<span class="pill">${escapeHtml(group)}</span>`).join('') || '—'}</td><td><div class="row-actions"><button data-roles-user="${escapeHtml(user.id)}" data-roles="${escapeHtml(user.membership.roles.join(','))}">Roles</button><button data-groups-user="${escapeHtml(user.id)}" data-groups="${escapeHtml(user.membership.groups.join(','))}">Groups</button></div></td></tr>`).join('');
    } catch (error) { notice(error.message, true); }
  }

  function renderOrganizations(organizations) {
    $('#organizations').innerHTML = organizations.map(org => `<article class="org-card"><p class="eyebrow">Organization</p><h2>${escapeHtml(org.name)}</h2><p>${org.roles.map(role => `<span class="pill">${escapeHtml(role)}</span>`).join('')}</p><code>${escapeHtml(org.id)}</code></article>`).join('');
  }

  $$('.tabs button').forEach(button => button.addEventListener('click', () => {
    $$('.tabs button').forEach(item => item.classList.toggle('active', item === button));
    $('#users-view').hidden = button.dataset.view !== 'users'; $('#organizations-view').hidden = button.dataset.view !== 'organizations';
  }));
  $('#organization-select').addEventListener('change', event => { state.organizationId = event.target.value; void loadUsers(); });
  $('#show-new-user').addEventListener('click', () => { $('#new-user').hidden = false; });
  $('#show-new-org').addEventListener('click', () => { $('#new-org').hidden = false; });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => { $(`#${button.dataset.close}`).hidden = true; }));

  $('#new-user').addEventListener('submit', async event => {
    event.preventDefault(); const formElement=event.currentTarget; const form = new FormData(formElement);
    try {
      await request('/users', { method: 'POST', body: JSON.stringify({ organizationId: state.organizationId, username: form.get('username'), email: form.get('email') || undefined, firstName: form.get('firstName') || undefined, lastName: form.get('lastName') || undefined, temporaryPassword: form.get('temporaryPassword'), roles: form.getAll('roles') }) });
      formElement.reset(); formElement.hidden = true; notice('User created with a temporary password.'); await loadUsers();
    } catch (error) { notice(error.message, true); }
  });
  $('#new-org').addEventListener('submit', async event => {
    event.preventDefault(); const formElement=event.currentTarget; const form = new FormData(formElement);
    try { await request('/organizations', { method: 'POST', body: JSON.stringify({ name: form.get('name'), slug: form.get('slug') }) }); formElement.reset(); formElement.hidden = true; notice('Organization created.'); await loadSession(); }
    catch (error) { notice(error.message, true); }
  });
  $('#users').addEventListener('click', async event => {
    const roles = event.target.closest('[data-roles-user]'); const groups = event.target.closest('[data-groups-user]');
    try {
      if (roles) { const value = window.prompt('Roles: owner, admin, editor, member, viewer', roles.dataset.roles); if (value === null) return; await request(`/users/${encodeURIComponent(roles.dataset.rolesUser)}`, { method: 'PATCH', body: JSON.stringify({ organizationId: state.organizationId, roles: value.split(',').map(item => item.trim()).filter(Boolean) }) }); }
      if (groups) { const value = window.prompt('Groups (comma separated)', groups.dataset.groups); if (value === null) return; await request(`/users/${encodeURIComponent(groups.dataset.groupsUser)}`, { method: 'PATCH', body: JSON.stringify({ organizationId: state.organizationId, groups: value.split(',').map(item => item.trim()).filter(Boolean) }) }); }
      notice('User updated.'); await loadUsers();
    } catch (error) { notice(error.message, true); }
  });

  sendReady(); void loadSession();
})();
