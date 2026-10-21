(() => {
  const api = window.location.pathname.startsWith('/services/accounts/') ? '/accounts-api/v1/web' : '/v1/web';
  const viewCopy = {
    overview: ['Server overview', 'Overview', 'Your organization, access, and active console sessions.'],
    people: ['Sulla Server', 'People', 'People, roles, and access to this organization.'],
    devices: ['Sulla Server', 'Devices', 'Review and revoke the browser sessions connected to your account.'],
    settings: ['Server administration', 'Settings', 'Manage your profile and organization settings.'],
  };
  const requestedView = new URLSearchParams(window.location.search).get('view');
  const embedded = window.parent !== window;
  const state = {
    session: null,
    organizationId: '',
    generation: 0,
    controller: new AbortController(),
    view: Object.hasOwn(viewCopy, requestedView) ? requestedView : 'people',
  };
  class RequestError extends Error {
    constructor(status, code) {
      super(code || `Request failed (${status})`);
      this.name = 'RequestError';
      this.status = status;
      this.code = code;
    }
  }
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

  if (embedded) $('.return-row').hidden = true;

  function nextGeneration() {
    state.controller.abort();
    state.controller = new AbortController();
    state.generation += 1;
  }

  function requestContext() {
    return {
      generation: state.generation,
      organizationId: state.organizationId,
      session: state.session,
      signal: state.controller.signal,
    };
  }

  function contextIsCurrent(context) {
    return context.generation === state.generation &&
      context.organizationId === state.organizationId &&
      context.session === state.session &&
      !context.signal.aborted;
  }

  function requireCurrent(context) {
    if (!contextIsCurrent(context)) throw new DOMException('The request is stale.', 'AbortError');
  }

  async function request(path, options = {}, context = requestContext()) {
    requireCurrent(context);
    const response = await fetch(`${api}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      signal: context.signal,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.method && options.method !== 'GET' ? { 'x-sulla-csrf': csrf() } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      requireCurrent(context);
      throw new RequestError(response.status, body.error);
    }
    const result = response.status === 204 ? null : await response.json();
    requireCurrent(context);
    return result;
  }

  function clearRenderedData() {
    $('#overview-org').textContent = 'Your server';
    $('#overview-user').textContent = 'Signed in';
    for (const id of ['member-count', 'admin-count', 'session-count', 'overview-slug', 'overview-roles', 'overview-groups']) $(`#${id}`).textContent = '—';
    $('#users').replaceChildren();
    $('#users-empty').hidden = true;
    $('#users-empty').textContent = 'No people are assigned to this organization.';
    $('#sessions').replaceChildren();
    $('#sessions-empty').hidden = true;
    $('#organizations').replaceChildren();
    $('#profile-form').reset();
    $('#profile-username').textContent = '';
    $('#organization-form').reset();
    $('#organization-slug').textContent = '';
    for (const id of ['new-user', 'new-org']) {
      $(`#${id}`).reset();
      $(`#${id}`).hidden = true;
    }
  }

  function lockSession(message = 'Sign in to open this part of the console.') {
    nextGeneration();
    state.session = null;
    state.organizationId = '';
    clearRenderedData();
    const select = $('#organization-select');
    select.replaceChildren();
    select.disabled = true;
    $('.organization-picker').hidden = true;
    $$('.view').forEach(section => { section.hidden = true; });
    $('#signed-out').querySelector('p').textContent = message;
    $('#signed-out').hidden = false;
    notice('');
  }

  function isStale(error, context) {
    return error?.name === 'AbortError' || !contextIsCurrent(context);
  }

  function isAuthenticationFailure(error) {
    if (!(error instanceof RequestError)) return false;
    if (error.status === 401) return true;
    return error.status === 403 && [
      'authentication_required',
      'web_session_required',
      'invalid_csrf',
      'organization membership is not active',
    ].includes(error.code);
  }

  function handleRequestError(error, context) {
    if (isStale(error, context)) return true;
    if (!isAuthenticationFailure(error)) return false;
    lockSession('Your session ended. Sign in again to continue.');
    if (embedded) window.parent.postMessage({ type: 'sulla.service.expired', version: 1, service: 'accounts' }, window.location.origin);
    return true;
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
    if (embedded) window.parent.postMessage({ type: 'sulla.service.ready', version: 1, service: 'accounts' }, window.location.origin);
  }

  function reportActivity() {
    if (embedded) window.parent.postMessage({ type: 'sulla.service.activity', version: 1, service: 'accounts' }, window.location.origin);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== window.location.origin || !event.data || event.data.version !== 1 || event.data.service !== 'accounts') return;
    if (event.data.type === 'sulla.service.session' &&
      typeof event.data.token === 'string' && event.data.token &&
      typeof event.data.organizationId === 'string' && event.data.organizationId &&
      Number.isFinite(Date.parse(event.data.expiresAt)) && Date.parse(event.data.expiresAt) > Date.now()) {
      void loadSession(event.data.organizationId);
    }
    if (event.data.type === 'sulla.service.lock') {
      lockSession('Session locked. Sign in again to continue.');
    }
  });

  async function loadSession(requiredOrganizationId = '') {
    nextGeneration();
    state.session = null;
    state.organizationId = requiredOrganizationId;
    clearRenderedData();
    $('#organization-select').replaceChildren();
    $('#organization-select').disabled = true;
    $('.organization-picker').hidden = true;
    $$('.view').forEach(section => { section.hidden = true; });
    const context = requestContext();
    try {
      const session = await request('/session', {}, context);
      requireCurrent(context);
      const selected = requiredOrganizationId
        ? session.organizations.find(organization => organization.id === requiredOrganizationId)
        : session.organizations[0];
      if (!selected) {
        lockSession(requiredOrganizationId
          ? 'Your session is not authorized for the selected organization.'
          : 'This account is not assigned to an organization.');
        if (embedded) window.parent.postMessage({ type: 'sulla.service.expired', version: 1, service: 'accounts' }, window.location.origin);
        return;
      }
      state.session = session;
      state.organizationId = selected.id;
      $('#signed-out').hidden = true;
      const select = $('#organization-select');
      select.replaceChildren(...session.organizations.map(organization => {
        const option = document.createElement('option');
        option.value = organization.id;
        option.textContent = organization.name;
        return option;
      }));
      select.value = state.organizationId;
      select.disabled = embedded || session.organizations.length < 2;
      $('.organization-picker').hidden = false;
      showView();
      await loadCurrentView();
    } catch (error) {
      if (!handleRequestError(error, context)) lockSession('Sign-in is unavailable. Sign in again to retry.');
    }
  }

  async function loadCurrentView() {
    if (!state.session || !state.organizationId) return;
    notice('');
    if (state.view === 'overview') await loadOverview();
    if (state.view === 'people') await loadUsers();
    if (state.view === 'devices') await loadSessions();
    if (state.view === 'settings') await loadSettings();
  }

  async function loadOverview() {
    const context = requestContext();
    try {
      const result = await request(`/overview?organizationId=${encodeURIComponent(context.organizationId)}`, {}, context);
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
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  }

  async function loadUsers() {
    const context = requestContext();
    try {
      const result = await request(`/users?organizationId=${encodeURIComponent(context.organizationId)}`, {}, context);
      const rows = result.users.filter(user => user.membership);
      $('#users-empty').hidden = rows.length > 0;
      $('#users').innerHTML = rows.map(user => `<tr><td><span class="avatar">${escapeHtml((user.firstName || user.username || '?')[0].toUpperCase())}</span><span><strong>${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username)}</strong><small>${escapeHtml(user.email || user.username)}</small></span></td><td><span class="pill ${user.enabled ? 'success' : 'disabled'}">${user.enabled ? 'Active' : 'Disabled'}</span></td><td>${user.membership.roles.map(role => `<span class="pill">${escapeHtml(role)}</span>`).join('')}</td><td>${user.membership.groups.map(group => `<span class="pill">${escapeHtml(group)}</span>`).join('') || '—'}</td><td><div class="row-actions"><button data-roles-user="${escapeHtml(user.id)}" data-roles="${escapeHtml(user.membership.roles.join(','))}">Roles</button><button data-groups-user="${escapeHtml(user.id)}" data-groups="${escapeHtml(user.membership.groups.join(','))}">Groups</button></div></td></tr>`).join('');
    } catch (error) {
      if (handleRequestError(error, context)) return;
      $('#users').replaceChildren();
      $('#users-empty').hidden = false;
      $('#users-empty').textContent = error.message === 'organization administration is not allowed'
        ? 'An organization owner or admin can manage people.'
        : error.message;
    }
  }

  async function loadSessions() {
    const context = requestContext();
    try {
      const result = await request(`/sessions?organizationId=${encodeURIComponent(context.organizationId)}`, {}, context);
      $('#sessions-empty').hidden = result.sessions.length > 0;
      $('#sessions').innerHTML = result.sessions.map(session => `<article class="session-card panel"><div class="device-icon" aria-hidden="true">▣</div><div><div class="session-title"><h2>Browser session</h2>${session.current ? '<span class="pill success">This browser</span>' : ''}</div><p>Last active ${escapeHtml(formatDate(session.lastActiveAt))}</p><small>Signed in ${escapeHtml(formatDate(session.createdAt))} · expires ${escapeHtml(formatDate(session.expiresAt))}</small></div><button class="button danger" type="button" data-revoke-session="${escapeHtml(session.id)}" data-current="${session.current ? 'true' : 'false'}">${session.current ? 'Sign out' : 'Revoke'}</button></article>`).join('');
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function renderOrganizations(organizations) {
    $('#organizations').innerHTML = organizations.map(organization => `<article class="org-card panel"><div class="org-mark">${escapeHtml(organization.name.slice(0, 2).toUpperCase())}</div><div><h2>${escapeHtml(organization.name)}</h2><p>${organization.roles.map(role => `<span class="pill">${escapeHtml(role)}</span>`).join('')}</p><code>${escapeHtml(organization.slug)}</code></div></article>`).join('');
  }

  async function loadSettings() {
    const context = requestContext();
    try {
      const result = await request('/profile', {}, context);
      const form = $('#profile-form');
      form.elements.firstName.value = result.profile.firstName || '';
      form.elements.lastName.value = result.profile.lastName || '';
      form.elements.email.value = result.profile.email || '';
      $('#profile-username').textContent = `@${result.profile.username}`;
      const organization = context.session.organizations.find(item => item.id === context.organizationId);
      if (!organization) throw new DOMException('The request is stale.', 'AbortError');
      $('#organization-form').elements.name.value = organization.name;
      $('#organization-slug').textContent = organization.slug;
      const canAdmin = organization.roles.some(role => role === 'owner' || role === 'admin');
      $('#organization-form').elements.name.disabled = !canAdmin;
      $('#organization-form').querySelector('button[type="submit"]').disabled = !canAdmin;
      renderOrganizations(context.session.organizations);
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  }

  $('#organization-select').addEventListener('change', event => {
    if (embedded || !state.session?.organizations.some(organization => organization.id === event.target.value)) return;
    nextGeneration();
    state.organizationId = event.target.value;
    clearRenderedData();
    showView();
    void loadCurrentView();
  });
  $('#refresh-sessions').addEventListener('click', () => void loadSessions());
  $('#show-new-user').addEventListener('click', () => { $('#new-user').hidden = false; });
  $('#show-new-org').addEventListener('click', () => { $('#new-org').hidden = false; });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => { $(`#${button.dataset.close}`).hidden = true; }));

  $('#new-user').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const context = requestContext();
    try {
      await request('/users', { method: 'POST', body: JSON.stringify({
        organizationId: context.organizationId,
        username: form.get('username'),
        email: form.get('email') || undefined,
        firstName: form.get('firstName') || undefined,
        lastName: form.get('lastName') || undefined,
        temporaryPassword: form.get('temporaryPassword'),
        roles: form.getAll('roles'),
      }) }, context);
      formElement.reset();
      formElement.hidden = true;
      notice('Person created with a temporary password.');
      await loadUsers();
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  });

  $('#users').addEventListener('click', async event => {
    const roles = event.target.closest('[data-roles-user]');
    const groups = event.target.closest('[data-groups-user]');
    if (!roles && !groups) return;
    const context = requestContext();
    try {
      if (roles) {
        const value = window.prompt('Roles: owner, admin, editor, member, viewer', roles.dataset.roles);
        if (value === null) return;
        await request(`/users/${encodeURIComponent(roles.dataset.rolesUser)}`, { method: 'PATCH', body: JSON.stringify({ organizationId: context.organizationId, roles: value.split(',').map(item => item.trim()).filter(Boolean) }) }, context);
      }
      if (groups) {
        const value = window.prompt('Groups (comma separated)', groups.dataset.groups);
        if (value === null) return;
        await request(`/users/${encodeURIComponent(groups.dataset.groupsUser)}`, { method: 'PATCH', body: JSON.stringify({ organizationId: context.organizationId, groups: value.split(',').map(item => item.trim()).filter(Boolean) }) }, context);
      }
      notice('Person updated.');
      await loadUsers();
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  });

  $('#sessions').addEventListener('click', async event => {
    const button = event.target.closest('[data-revoke-session]');
    if (!button) return;
    const context = requestContext();
    try {
      await request(`/sessions/${encodeURIComponent(button.dataset.revokeSession)}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ organizationId: context.organizationId }),
      }, context);
      if (button.dataset.current === 'true') { window.top.location.href = '/console'; return; }
      notice('Browser session revoked.');
      await loadSessions();
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  });

  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const context = requestContext();
    try {
      await request('/profile', { method: 'PATCH', body: JSON.stringify({
        firstName: form.get('firstName'),
        lastName: form.get('lastName'),
        email: form.get('email'),
      }) }, context);
      notice('Profile saved.');
      await loadSettings();
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  });

  $('#organization-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const context = requestContext();
    try {
      await request(`/organizations/${encodeURIComponent(context.organizationId)}`, { method: 'PATCH', body: JSON.stringify({ name: form.get('name') }) }, context);
      notice('Organization saved.');
      await loadSession(context.organizationId);
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  });

  $('#new-org').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const context = requestContext();
    try {
      const created = await request('/organizations', { method: 'POST', body: JSON.stringify({ name: form.get('name'), slug: form.get('slug') }) }, context);
      formElement.reset();
      formElement.hidden = true;
      notice('Organization created.');
      await loadSession(embedded ? context.organizationId : created.id);
    } catch (error) { if (!handleRequestError(error, context)) notice(error.message, true); }
  });

  for (const eventName of ['pointerdown', 'keydown']) window.addEventListener(eventName, reportActivity, { passive: true });
  showView();
  sendReady();
  if (embedded) lockSession();
  else void loadSession();
})();
