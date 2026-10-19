'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = { token: '', expiresAt: 0, generation: 0, navigation: 0, organizationId: '', project: null, projects: [], tasks: [], epics: [], lanes: [], table: false, editing: null, busy: false };
  const apiBase = location.pathname.startsWith('/services/projects/') ? '/services/projects/api/' : '/v1/';
  const origin = location.origin;
  let expiryTimer;
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
  function button(text, action, className) { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', () => Promise.resolve(action()).catch(error => notice(error.message))); return node; }
  function notice(message = '') { $('notice').textContent = message; }
  function lock(message = 'Your session is locked. Sign in through the main console.') {
    clearTimeout(expiryTimer); state.token = ''; state.organizationId = ''; state.generation++; state.navigation++; state.project = null; state.projects = []; state.tasks = []; state.epics = []; state.lanes = [];
    $('editor').close(); state.editing = null; $('fields').replaceChildren(); $('comments').replaceChildren(); $('form-error').textContent = ''; $('search').value = ''; $('epic-filter').replaceChildren(); $('project-nav').replaceChildren(); $('content').replaceChildren(el('p', message, 'empty')); $('session').textContent = message;
    $('add').disabled = true; $('edit-project').hidden = true; $('add-epic').hidden = true; $('manage-epics').hidden = true; $('view').hidden = true; $('epic-filter').hidden = true;
    $('title').textContent = 'Projects';
  }
  async function rpc(operation, ...args) {
    if (!state.token || Date.now() >= state.expiresAt) { lock(); throw new Error('Your session has expired. Return to the main menu to sign in.'); }
    const generation = state.generation;
    const response = await fetch(`${apiBase}rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` }, body: JSON.stringify({ operation, args }), cache: 'no-store', credentials: 'omit' });
    if (generation !== state.generation) throw new Error('Session changed.');
    if (response.status === 401) { lock(); throw new Error('Your session has expired.'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 403 ? 'Your account does not have permission for this change.' : body.error || `Projects request failed (${response.status}).`);
    return body.result;
  }
  function renderNavigation() {
    $('project-nav').replaceChildren(...state.projects.map(project => {
      const node = button(project.title, () => openProject(project.id));
      if (state.project?.id === project.id) node.setAttribute('aria-current', 'page');
      return node;
    }));
  }
  async function refresh() {
    notice(); const generation = state.generation;
    const projects = await rpc('listProjects', { includeDone: true, limit: 500 });
    if (generation !== state.generation) return;
    state.projects = projects; renderNavigation();
    if (state.project) await openProject(state.project.id); else render();
  }
  async function openProject(id) {
    notice(); const generation = state.generation, navigation = ++state.navigation;
    const [project, tasks, epics, lanes] = await Promise.all([rpc('getProject', id), rpc('listTasks', { projectId: id, includeDone: true, limit: 1000 }), rpc('listEpics', { projectId: id, includeDone: true, limit: 500 }), rpc('resolveEffectiveLanes', id)]);
    if (generation !== state.generation) return;
    if (navigation !== state.navigation) return;
    if (!project) throw new Error('This project is no longer available.');
    state.project = project; state.tasks = tasks; state.epics = epics; state.lanes = lanes.filter(lane => lane.enabled && !lane.archived);
    $('epic-filter').replaceChildren(new Option('All epics', ''), new Option('No epic', '__none'), ...epics.map(epic => new Option(epic.title, epic.id)));
    $('search').value = ''; renderNavigation(); render();
  }
  function meta(item) { return el('div', [item.status, item.priority, item.assignee].filter(Boolean).join(' · '), 'meta'); }
  function taskCard(task) {
    const node = button('', () => edit('task', task), 'task-card'); node.append(el('h3', task.title), meta(task)); return node;
  }
  function render() {
    const project = state.project, query = $('search').value.toLowerCase().trim();
    $('title').textContent = project?.title || 'Projects'; $('eyebrow').textContent = project ? 'Project workspace' : 'Workspace';
    $('add').disabled = !state.token || state.busy; $('add').textContent = project ? 'Add card' : 'New project';
    $('edit-project').hidden = !project; $('add-epic').hidden = !project; $('manage-epics').hidden = !project; $('view').hidden = !project; $('epic-filter').hidden = !project;
    $('view').textContent = state.table ? 'Board view' : 'Table view'; $('search').placeholder = project ? 'Search cards' : 'Search projects';
    const content = $('content'); content.replaceChildren();
    if (!project) {
      const grid = el('div', undefined, 'grid');
      for (const item of state.projects.filter(item => `${item.title} ${item.description || ''}`.toLowerCase().includes(query))) {
        const card = button('', () => openProject(item.id), 'project-card'); card.append(el('h3', item.title), el('p', item.description || 'Open project'), meta(item)); grid.append(card);
      }
      content.append(grid.children.length ? grid : el('p', query ? 'No matching projects.' : 'Create your first project to start organizing work.', 'empty')); return;
    }
    const epic = $('epic-filter').value;
    const tasks = state.tasks.filter(task => `${task.title} ${task.description || ''}`.toLowerCase().includes(query) && (!epic || (epic === '__none' ? !task.epic_id : task.epic_id === epic)));
    if (state.table) {
      const wrap = el('div', undefined, 'table-wrap'), table = el('table'), head = el('tr');
      for (const title of ['Card', 'Status', 'Priority', 'Assignee']) head.append(el('th', title)); table.append(head);
      for (const task of tasks) { const row = el('tr'), title = el('td'); title.append(button(task.title, () => edit('task', task))); row.append(title, el('td', task.status), el('td', task.priority), el('td', task.assignee || '—')); table.append(row); }
      wrap.append(table); content.append(wrap); if (!tasks.length) content.append(el('p', 'No cards to display.', 'empty')); return;
    }
    const board = el('div', undefined, 'board');
    const lanes = [...state.lanes];
    for (const task of tasks) if (!lanes.some(lane => lane.lane_key === task.status)) lanes.push({ lane_key: task.status, display_name: task.status });
    for (const lane of lanes) {
      const column = el('section', undefined, 'lane'), cards = tasks.filter(task => task.status === lane.lane_key);
      column.append(el('h3', `${lane.display_name} · ${cards.length}`), ...cards.map(taskCard), button('+ Add card', () => edit('task', { status: lane.lane_key })));
      board.append(column);
    }
    content.append(board.children.length ? board : el('p', 'This project has no configured lanes yet.', 'empty'));
  }
  function field(name, title, value = '', options) {
    const label = el('label', title), control = options ? el('select') : el(name === 'description' || name === 'comment' ? 'textarea' : 'input');
    control.name = name; if (options) control.append(...options.map(([value, title]) => new Option(title, value))); control.value = value || '';
    if (name === 'title') { control.required = true; control.maxLength = 500; }
    label.append(control); $('fields').append(label); return control;
  }
  async function edit(kind, item = {}) {
    if (kind === 'task' && !state.epics.length) { notice('Add an epic before creating a card.'); return edit('epic'); }
    state.editing = { kind, item }; $('save').hidden = false; $('form-error').textContent = ''; $('comments').replaceChildren(); $('fields').replaceChildren();
    $('editor-title').textContent = `${item.id ? 'Edit' : 'New'} ${kind === 'task' ? 'card' : kind}`;
    field('title', 'Title', item.title); field('description', 'Description', item.description);
    field('priority', 'Priority', item.priority || 'p2', ['p0', 'p1', 'p2', 'p3', 'p4'].map(value => [value, value]));
    if (kind === 'task') {
      const statuses = state.lanes.map(lane => [lane.lane_key, lane.display_name]);
      if (item.status && !statuses.some(([key]) => key === item.status)) statuses.push([item.status, item.status]);
      if (statuses.length) field('status', 'Status', item.status || statuses[0][0], statuses);
      field('epic_id', 'Epic', item.epic_id || state.epics[0]?.id, state.epics.map(epic => [epic.id, epic.title])).required = true;
      field('assignee', 'Assigned agent', item.assignee); if (item.id) field('comment', 'Add comment');
    } else if (kind === 'project') field('assigned_agent', 'Assigned agent', item.assigned_agent);
    $('archive').hidden = !item.id; $('save').disabled = false; $('archive').disabled = false; $('editor').showModal();
    if (kind === 'task' && item.id) {
      try {
        const comments = await rpc('listComments', item.id);
        if (state.editing?.item.id !== item.id || !$('editor').open) return;
        $('comments').append(el('h3', 'Activity'));
        for (const comment of comments) { const node = el('div', undefined, 'comment'); node.append(el('small', `${comment.author} · ${new Date(comment.created_at).toLocaleString()}`), el('div', comment.body)); $('comments').append(node); }
      } catch (error) { $('form-error').textContent = error.message; }
    }
  }
  $('edit-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.busy) return; state.busy = true; $('add').disabled = true; $('save').disabled = true; $('form-error').textContent = '';
    const form = event.currentTarget;
    const { kind, item } = state.editing, values = Object.fromEntries(new FormData(form)); const comment = values.comment?.trim(); delete values.comment;
    if ('epic_id' in values) values.epic_id ||= null;
    if ('assignee' in values) values.assignee ||= null;
    if ('assigned_agent' in values) values.assigned_agent ||= null;
    try {
      if (item.id) await rpc(`update${kind[0].toUpperCase()}${kind.slice(1)}`, item.id, values);
      else { if (kind !== 'project') values.project_id = state.project.id; await rpc(`create${kind[0].toUpperCase()}${kind.slice(1)}`, values); }
      // Clear a posted comment immediately so retrying a subsequent refresh cannot duplicate it.
      if (comment) { await rpc('addComment', { task_id: item.id, body: comment }); form.elements.comment.value = ''; }
      $('editor').close(); await refresh();
    } catch (error) { $('form-error').textContent = error.message; notice(error.message); }
    finally { state.busy = false; $('save').disabled = false; $('add').disabled = !state.token; }
  });
  $('archive').addEventListener('click', async () => {
    if (state.busy || !confirm('Archive this item? It will be hidden from the active workspace.')) return;
    state.busy = true; $('archive').disabled = true;
    try { const { kind, item } = state.editing; await rpc('archive', kind, item.id); if (kind === 'project') state.project = null; $('editor').close(); await refresh(); }
    catch (error) { $('form-error').textContent = error.message; }
    finally { state.busy = false; $('archive').disabled = false; }
  });
  $('close').onclick = () => { if (!state.busy) $('editor').close(); };
  $('editor').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  $('all-projects').onclick = () => { state.navigation++; state.project = null; $('search').value = ''; renderNavigation(); render(); };
  $('add').onclick = () => edit(state.project ? 'task' : 'project');
  $('edit-project').onclick = () => edit('project', state.project);
  $('add-epic').onclick = () => edit('epic');
  $('manage-epics').onclick = () => {
    $('editor-title').textContent = 'Epics'; $('fields').replaceChildren(); $('comments').replaceChildren(); $('form-error').textContent = '';
    $('save').hidden = true; $('archive').hidden = true;
    for (const epic of state.epics) $('fields').append(button(epic.title, () => edit('epic', epic), 'project-card'));
    if (!state.epics.length) $('fields').append(el('p', 'No epics yet.'));
    $('fields').append(button('Add epic', () => edit('epic'))); $('editor').showModal();
  };
  $('refresh').onclick = () => refresh().catch(error => notice(error.message));
  $('search').oninput = render; $('epic-filter').onchange = render; $('view').onclick = () => { state.table = !state.table; render(); };
  window.addEventListener('message', async event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== origin) return;
    const message = event.data;
    if (!message || message.version !== 1 || message.service !== 'projects') return;
    if (message.type === 'sulla.service.lock') { lock(); return; }
    if (message.type !== 'sulla.service.session' || typeof message.token !== 'string' || !message.token) return;
    const expiresAt = typeof message.expiresAt === 'number' ? message.expiresAt : Date.parse(message.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { lock(); return; }
    const changed = !state.token || state.organizationId !== message.organizationId;
    if (changed) lock('Connecting to Projects…');
    state.organizationId = message.organizationId;
    state.token = message.token; state.expiresAt = expiresAt; $('session').textContent = 'Connected'; clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => lock(), Math.min(expiresAt - Date.now(), 2147483647));
    if (changed) await refresh().catch(error => notice(error.message));
  });
  lock('Open Projects through the server console to connect.');
  if (window.parent !== window) window.parent.postMessage({ type: 'sulla.service.ready', version: 1, service: 'projects' }, origin);
})();
