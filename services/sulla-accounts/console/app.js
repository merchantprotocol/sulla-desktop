(() => {
  const api = window.location.pathname.startsWith('/services/accounts/') ? '/accounts-api/v1/web' : '/v1/web';
  const viewCopy = {
    overview: ['Server overview', 'Overview', 'Your organization, access, and active console sessions.'],
    people: ['Sulla Accounts', 'People', 'People, roles, and access to this organization.'],
    devices: ['Sulla Accounts', 'Devices', 'Review and revoke the browser sessions connected to your account.'],
    settings: ['Server administration', 'Settings', 'Manage your profile and organization settings.'],
  };
  const requestedView = new URLSearchParams(window.location.search).get('view');
  const state = {
    session: null,
    organizationId: '',
    view: Object.hasOwn(viewCopy, requestedView) ? requestedView : 'people',
  };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const csrf = () => {
    const value = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('sulla-console-csrf='));
    return value ? decodeURIComponent(value.split('=').slice(1).join('=')) : '';
  };
  const notice = (message, error = false) => {
    const element = $('#notice');
    element.textContent = message;
    element.className = `notice${error ? ' error' : ''}`;
    element.hidden = !message;
  };

  if (window.parent !== window) $('.return-row').hidden = true;

  async function request(path, options = {}) {
    const response = await fetch(`${api}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.method && options.method !== 'GET' ? { 'x-sulla-csrf': csrf() } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  function selectedOrganization() {
    return state.session?.organizations.find(organization => organization.id === state.organizationId);
  }

  function showView() {
    const [eyebrow, title, description] = viewCopy[state.view];
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    $('#page-description').textContent = description;
    $$('.view').forEach(section => { section.hidden = section.id !== `${state.view}-view`; });
    document.title = `${title} · Sulla`;
  }

  function sendReady() {
    if (window.parent !== window) window.parent.postMessage({ type: 'sulla.service.ready', version: 1, service: 'accounts' }, window.location.origin);
  }

  function reportActivity() {
    if (window.parent !== window) window.parent.postMessage({ type: 'sulla.service.activity', version: 1, service: 'accounts' }, window.location.origin);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== window.location.origin || !event.data || event.data.version !== 1 || event.data.service !== 'accounts') return;
    if (event.data.type === 'sulla.service.session' && typeof event.data.organizationId === 'string') {
      if (state.session?.organizations.some(organization => organization.id === event.data.organizationId)) {
        state.organizationId = event.data.organizationId;
        $('#organization-select').value = state.organizationId;
        void loadCurrentView();
      }
    }
    if (event.data.type === 'sulla.service.lock') {
      state.session = null;
      $$('.view').forEach(section => { section.hidden = true; });
      $('#signed-out').hidden = false;
      notice('Session locked. Sign in again to continue.', true);
    }
  });

  async function loadSession() {
    try {
      state.session = await request('/session');
      $('#signed-out').hidden = true;
      const select = $('#organization-select');
      select.replaceChildren(...state.session.organizations.map(organization => {
        const option = document.createElement('option');
        option.value = organization.id;
        option.textContent = organization.name;
        return option;
      }));
      state.organizationId = state.session.organizations.some(organization => organization.id === state.organizationId)
        ? state.organizationId
        : state.session.organizations[0]?.id || '';
      select.value = state.organizationId;
      select.disabled = state.session.organizations.length < 2;
      showView();
      if (state.organizationId) await loadCurrentView();
      else notice('This account is not assigned to an organization.', true);
    } catch {
      $$('.view').forEach(section => { section.hidden = true; });
      $('.organization-picker').hidden = true;
      $('#signed-out').hidden = false;
    }
  }

  async function loadCurrentView() {
    notice('');
    if (state.view === 'overview') await loadOverview();
    if (state.view === 'people') await loadUsers();
    if (state.view === 'devices') await loadSessions();
    if (state.view === 'settings') await loadSettings();
  }

  async function loadOverview() {
    try {
      const result = await request(`/overview?organizationId=${encodeURIComponent(state.organizationId)}`);
      const organization = result.organization;
      const displayName = [result.user.firstName, result.user.lastName].filter(Boolean).join(' ') || result.user.username;
      $('#overview-org').textContent = organization.name;
      $('#overview-user').textContent = displayName;
      $('#member-count').textContent = result.summary.members;
      $('#admin-count').textContent = result.summary.administrators;
      $('#session-count').textContent = result.summary.browserSessions;
      $('#overview-slug').textContent = organization.slug;
      $('#overview-roles').textContent = organization.roles.join(', ') || 'Member';
      $('#overview-groups').textContent = organization.groups.join(', ') || 'No groups';
    } catch (error) { notice(error.message, true); }
  }

  async function loadUsers() {
    try {
      const result = await request(`/users?organizationId=${encodeURIComponent(state.organizationId)}`);
      const rows = result.users.filter(user => user.membership);
      $('#users-empty').hidden = rows.length > 0;
      $('#users').innerHTML = rows.map(user => `<tr><td><span class="avatar">${escapeHtml((user.firstName || user.username || '?')[0].toUpperCase())}</span><span><strong>${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username)}</strong><small>${escapeHtml(user.email || user.username)}</small></span></td><td><span class="pill ${user.enabled ? 'success' : 'disabled'}">${user.enabled ? 'Active' : 'Disabled'}</span></td><td>${user.membership.roles.map(role => `<span class="pill">${escapeHtml(role)}</span>`).join('')}</td><td>${user.membership.groups.map(group => `<span class="pill">${escapeHtml(group)}</span>`).join('') || '—'}</td><td><div class="row-actions"><button data-roles-user="${escapeHtml(user.id)}" data-roles="${escapeHtml(user.membership.roles.join(','))}">Roles</button><button data-groups-user="${escapeHtml(user.id)}" data-groups="${escapeHtml(user.membership.groups.join(','))}">Groups</button></div></td></tr>`).join('');
    } catch (error) {
      $('#users').replaceChildren();
      $('#users-empty').hidden = false;
      $('#users-empty').textContent = error.message === 'organization administration is not allowed'
        ? 'An organization owner or admin can manage people.'
        : error.message;
    }
  }

  async function loadSessions() {
    try {
      const result = await request(`/sessions?organizationId=${encodeURIComponent(state.organizationId)}`);
      $('#sessions-empty').hidden = result.sessions.length > 0;
      $('#sessions').innerHTML = result.sessions.map(session => `<article class="session-card panel"><div class="device-icon" aria-hidden="true">▣</div><div><div class="session-title"><h2>Browser session</h2>${session.current ? '<span class="pill success">This browser</span>' : ''}</div><p>Last active ${escapeHtml(formatDate(session.lastActiveAt))}</p><small>Signed in ${escapeHtml(formatDate(session.createdAt))} · expires ${escapeHtml(formatDate(session.expiresAt))}</small></div><button class="button danger" type="button" data-revoke-session="${escapeHtml(session.id)}" data-current="${session.current ? 'true' : 'false'}">${session.current ? 'Sign out' : 'Revoke'}</button></article>`).join('');
    } catch (error) { notice(error.message, true); }
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function renderOrganizations(organizations) {
    $('#organizations').innerHTML = organizations.map(organization => `<article class="org-card panel"><div class="org-mark">${escapeHtml(organization.name.slice(0, 2).toUpperCase())}</div><div><h2>${escapeHtml(organization.name)}</h2><p>${organization.roles.map(role => `<span class="pill">${escapeHtml(role)}</span>`).join('')}</p><code>${escapeHtml(organization.slug)}</code></div></article>`).join('');
  }

  async function loadSettings() {
    try {
      const result = await request('/profile');
      const form = $('#profile-form');
      form.elements.firstName.value = result.profile.firstName || '';
      form.elements.lastName.value = result.profile.lastName || '';
      form.elements.email.value = result.profile.email || '';
      $('#profile-username').textContent = `@${result.profile.username}`;
      const organization = selectedOrganization();
      $('#organization-form').elements.name.value = organization.name;
      $('#organization-slug').textContent = organization.slug;
      const canAdmin = organization.roles.some(role => role === 'owner' || role === 'admin');
      $('#organization-form').elements.name.disabled = !canAdmin;
      $('#organization-form').querySelector('button[type="submit"]').disabled = !canAdmin;
      renderOrganizations(state.session.organizations);
    } catch (error) { notice(error.message, true); }
  }

  $('#organization-select').addEventListener('change', event => {
    state.organizationId = event.target.value;
    void loadCurrentView();
  });
  $('#open-projects').addEventListener('click', () => {
    if (window.parent === window) { window.location.href = '/console'; return; }
    window.parent.postMessage({ type: 'sulla.console.open', version: 1, service: 'accounts', target: 'projects' }, window.location.origin);
  });
  $('#refresh-sessions').addEventListener('click', () => void loadSessions());
  $('#show-new-user').addEventListener('click', () => { $('#new-user').hidden = false; });
  $('#show-new-org').addEventListener('click', () => { $('#new-org').hidden = false; });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => { $(`#${button.dataset.close}`).hidden = true; }));

  $('#new-user').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await request('/users', { method: 'POST', body: JSON.stringify({
        organizationId: state.organizationId,
        username: form.get('username'),
        email: form.get('email') || undefined,
        firstName: form.get('firstName') || undefined,
        lastName: form.get('lastName') || undefined,
        temporaryPassword: form.get('temporaryPassword'),
        roles: form.getAll('roles'),
      }) });
      formElement.reset();
      formElement.hidden = true;
      notice('Person created with a temporary password.');
      await loadUsers();
    } catch (error) { notice(error.message, true); }
  });

  $('#users').addEventListener('click', async event => {
    const roles = event.target.closest('[data-roles-user]');
    const groups = event.target.closest('[data-groups-user]');
    try {
      if (roles) {
        const value = window.prompt('Roles: owner, admin, editor, member, viewer', roles.dataset.roles);
        if (value === null) return;
        await request(`/users/${encodeURIComponent(roles.dataset.rolesUser)}`, { method: 'PATCH', body: JSON.stringify({ organizationId: state.organizationId, roles: value.split(',').map(item => item.trim()).filter(Boolean) }) });
      }
      if (groups) {
        const value = window.prompt('Groups (comma separated)', groups.dataset.groups);
        if (value === null) return;
        await request(`/users/${encodeURIComponent(groups.dataset.groupsUser)}`, { method: 'PATCH', body: JSON.stringify({ organizationId: state.organizationId, groups: value.split(',').map(item => item.trim()).filter(Boolean) }) });
      }
      notice('Person updated.');
      await loadUsers();
    } catch (error) { notice(error.message, true); }
  });

  $('#sessions').addEventListener('click', async event => {
    const button = event.target.closest('[data-revoke-session]');
    if (!button) return;
    try {
      await request(`/sessions/${encodeURIComponent(button.dataset.revokeSession)}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ organizationId: state.organizationId }),
      });
      if (button.dataset.current === 'true') { window.top.location.href = '/console'; return; }
      notice('Browser session revoked.');
      await loadSessions();
    } catch (error) { notice(error.message, true); }
  });

  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await request('/profile', { method: 'PATCH', body: JSON.stringify({
        firstName: form.get('firstName'),
        lastName: form.get('lastName'),
        email: form.get('email'),
      }) });
      notice('Profile saved.');
      await loadSettings();
    } catch (error) { notice(error.message, true); }
  });

  $('#organization-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await request(`/organizations/${encodeURIComponent(state.organizationId)}`, { method: 'PATCH', body: JSON.stringify({ name: form.get('name') }) });
      notice('Organization saved.');
      await loadSession();
    } catch (error) { notice(error.message, true); }
  });

  $('#new-org').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const created = await request('/organizations', { method: 'POST', body: JSON.stringify({ name: form.get('name'), slug: form.get('slug') }) });
      state.organizationId = created.id;
      formElement.reset();
      formElement.hidden = true;
      notice('Organization created.');
      await loadSession();
    } catch (error) { notice(error.message, true); }
  });

  for (const eventName of ['pointerdown', 'keydown']) window.addEventListener(eventName, reportActivity, { passive: true });
  showView();
  sendReady();
  void loadSession();
})();
