// Sulla Server app: the shared shell every /cloud/ page renders.
//
// A page is plain HTML: <body data-route="files"> plus these scripts. The
// shell signs the user in, resolves the organization, draws the sidebar and
// top bar, then hands the page body to the screen registered for the route
// (CloudShell.screen). Routes with no screen yet get an honest "not connected
// yet" body. Nothing here invents data: every count, org and device shown
// comes from the API, and anything without a source is left out.
//
// Screen contract (later chunks):
//   CloudShell.screen({
//     mount(ctx),   // ctx = { view, org, profile, api, states, shell }
//     reload(ctx),  // optional; runs after every org switch (defaults to mount)
//   });
//   CloudShell.setNavCount(navId, value, kind)   // kind: '', 'warn', 'live'
//   CloudShell.setSubnav(navId, groups | null)   // expandable group under a nav item
//   CloudShell.setCrumbs([{ label, href }])      // trail after the org name
//   CloudShell.toast(message)
(function () {
  'use strict';

  const api = window.CloudApi;
  const states = window.CloudStates;
  const ic = (name) => window.CloudIcons.get(name);
  const $ = (sel, root = document) => root.querySelector(sel);
  const serverHost = () => document.querySelector('meta[name="sulla-server-host"]')?.content || location.host;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Routes ────────────────────────────────────────────────────────────
  const NAV = [
    { id: 'home', label: 'Home', icon: 'home', href: 'index.html' },
    { id: 'chat', label: 'Chat', icon: 'message', href: 'chat.html' },
    { id: 'files', label: 'Files', icon: 'folderLine', href: 'files.html' },
    { id: 'passwords', label: 'Passwords', icon: 'key', href: 'passwords.html' },
    // Workflows and Agents stay top-level shortcuts; both pages open inside
    // the Use Cases (Studio) sidebar, like the Desktop rail.
    { id: 'workflows', label: 'Workflows', icon: 'workflow', href: 'workflows.html' },
    { id: 'agents', label: 'Agents', icon: 'agent', href: 'agents.html' },
    { id: 'use-cases', label: 'Use Cases', icon: 'grid', href: 'use-cases.html' },
    { id: 'organizations', label: 'Organizations', icon: 'building', href: 'organizations.html' },
  ];

  // route -> nav item it lives under, crumb trail, and the body shown until
  // the screen's own chunk is built.
  const ROUTES = {
    home: { nav: 'home', title: 'Home', soon: ['Devices online and running agents', 'Recent chats, workflow runs and files', 'Shared links and vault sync status'] },
    chat: { nav: 'chat', title: 'Chat', soon: ['Cloud chats and chats you link from Sulla Desktop', 'Where each reply runs, with a Runs on picker', 'Linking is opt-in; nothing uploads until you turn it on'] },
    files: { nav: 'files', title: 'Files', soon: ['Files from Sulla Server and your online devices', 'Shared by you and shared with you', 'Previews, history and share links'] },
    editor: { nav: 'files', title: 'Editor', crumbs: [{ label: 'Files', href: 'files.html' }, { label: 'Editor' }], soon: ['Edit Sulla documents in the browser', 'Saves a new version and flags conflicts', 'Live presence and version history by device'] },
    passwords: { nav: 'passwords', title: 'Passwords', soon: ['Your vault, synced from Sulla Desktop › Profile when you turn sync on', 'Unlocks in this browser only; the server never sees your passwords', 'Audit log and vault settings'] },
    workflows: { nav: 'use-cases', title: 'Workflows', soon: ['Status, last run and the last 12 runs', 'Next run, trigger, and where each one runs', 'Run detail with steps and logs'] },
    'workflow-run': { nav: 'use-cases', title: 'Run', crumbs: [{ label: 'Workflows', href: 'workflows.html' }, { label: 'Run' }], soon: ['Step timeline for one run', 'Output of the failing step', 'Run details and the full log'] },
    agents: { nav: 'use-cases', title: 'Live Agents', soon: ['Agents running in Sulla Server and on each device', 'Message or stop an agent', 'Offline devices shown as last seen, never as running'] },
    'use-cases': { nav: 'use-cases', title: 'Use Cases', soon: ['Browse use cases and read each one', 'Install to Sulla Server or to a device', 'My Library and updates'] },
    skills: { nav: 'use-cases', title: 'Saved Skills' },
    'custom-agents': { nav: 'use-cases', title: 'Custom Agents' },
    recipes: { nav: 'use-cases', title: 'Recipes' },
    usage: { nav: 'use-cases', title: 'Token Usage' },
    organizations: { nav: 'organizations', title: 'Organizations', soon: ['Every organization you belong to', 'Link another organization', 'How switching re-scopes every screen'] },
    devices: { nav: 'home', title: 'Devices', crumbs: [{ label: 'Home', href: 'index.html' }, { label: 'Devices' }] },
    account: { title: 'Account settings' },
    'org-settings': { title: 'Organization settings' },
    'server-admin': { title: 'Server administration' },
    'not-found': { title: 'Page not found' },
  };

  // Server timestamps are UTC when they have no explicit zone.
  function parseDate(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function localWhen(value) {
    const d = parseDate(value);
    return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
  }

  // Static submenus. Counts and data-driven groups (vault collections, use
  // case topics) are added by each screen through setSubnav.
  const SUBNAV = {
    files: [
      { title: 'Browse', items: [
        { id: 'files', label: 'Files', icon: 'folderLine', href: 'files.html#sec=files' },
        { id: 'shared', label: 'Shared', icon: 'share', href: 'files.html#sec=shared' },
        { id: 'recent', label: 'Recent', icon: 'clock', href: 'files.html#sec=recent' },
        { id: 'starred', label: 'Starred', icon: 'star', href: 'files.html#sec=starred' },
      ] },
      { title: 'More', items: [
        { id: 'agent', label: 'Agent files', icon: 'agent', href: 'files.html#sec=agent' },
        { id: 'trash', label: 'Trash', icon: 'trash', href: 'files.html#sec=trash' },
      ] },
    ],
    'use-cases': [
      { title: 'Library', items: [
        { id: 'browse', label: 'Browse', icon: 'grid', href: 'use-cases.html#uc=browse', active: () => state.route === 'use-cases' && activeSub('use-cases') === 'browse' },
        { id: 'library', label: 'My Library', icon: 'lib', href: 'use-cases.html#uc=library', active: () => state.route === 'use-cases' && activeSub('use-cases') === 'library' },
        { id: 'updates', label: 'Updates', icon: 'up', href: 'use-cases.html#uc=updates', active: () => state.route === 'use-cases' && activeSub('use-cases') === 'updates' },
      ] },
      { title: 'Build', items: [
        { id: 'workflows', label: 'Workflows', icon: 'workflow', href: 'workflows.html', active: () => state.route === 'workflows' || state.route === 'workflow-run' },
        { id: 'skills', label: 'Saved Skills', icon: 'bolt', href: 'skills.html', active: () => state.route === 'skills' },
        { id: 'custom-agents', label: 'Custom Agents', icon: 'agent', href: 'custom-agents.html', active: () => state.route === 'custom-agents' },
        { id: 'recipes', label: 'Recipes', icon: 'box', href: 'recipes.html', active: () => state.route === 'recipes' },
      ] },
      { title: 'Monitor', items: [
        { id: 'live', label: 'Live Agents', icon: 'syncOnline', href: 'agents.html', active: () => state.route === 'agents' },
        { id: 'usage', label: 'Token Usage', icon: 'list', href: 'usage.html', active: () => state.route === 'usage' },
      ] },
    ],
    // Passwords opens its submenu only while the vault is unlocked, and only
    // the Passwords screen knows that, so it starts closed.
  };
  const SUB_PARAM = { files: 'sec', 'use-cases': 'uc' };
  const SUB_DEFAULT = { files: 'files', 'use-cases': 'browse' };

  // ── State ─────────────────────────────────────────────────────────────
  const state = {
    route: 'home',
    devices: null, // null = loading, [] = none, false = failed
    showOlder: false,
    counts: {},
    subnav: {},
    crumbs: null,
    screen: null,
    memberCount: null,
    commandOpen: false,
    commandIndex: 0,
    commandQuery: '',
    commandReturnFocus: null,
    settings: null,
    settingsActive: null,
    settingsHidden: new Set(),
  };

  function activeSub(navId) {
    const key = SUB_PARAM[navId];
    if (!key || ROUTES[state.route]?.nav !== navId || state.route === 'editor') return null;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    return params.get(key) || SUB_DEFAULT[navId];
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  function orgAvatar(org, extra = '') {
    const initials = String(org?.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const color = /^#[0-9a-f]{3,8}$/i.test(org?.color || '') ? ` style="background:${org.color}"` : '';
    // No team colour set: pick one of the mockup's avatar gradients, stable per org id.
    const hash = [...String(org?.id || '')].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 0);
    const tone = ['a', 'd', 'p', 'm'][hash % 4];
    return `<span class="avatar sq ${tone} ${extra}"${color}>${esc(initials || '?')}</span>`;
  }

  function personInitials(profile) {
    const name = profile?.name || profile?.businessName || profile?.email || '';
    return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  }

  function countHtml(c) {
    if (!c || c.value === undefined || c.value === null || c.value === '' || c.value === 0) return '';
    return `<span class="cnt ${esc(c.kind || '')}">${esc(c.value)}</span>`;
  }

  function subnavHtml(navId) {
    const groups = state.subnav[navId] !== undefined ? state.subnav[navId] : SUBNAV[navId];
    if (!groups || !groups.length) return '';
    const current = activeSub(navId);
    let h = '<div class="nav-subgroup">';
    groups.forEach((g, i) => {
      if (i > 0) h += '<div class="sg-sep"></div>';
      if (g.title) h += `<div class="sg-h">${esc(g.title)}</div>`;
      (g.items || []).forEach((it) => {
        const on = typeof it.active === 'function' ? it.active() : (it.active !== undefined ? it.active : current === it.id);
        const glyph = it.dot ? `<span class="tdot" style="background:${esc(it.dot)}"></span>` : ic(it.icon || 'note');
        h += `<a href="${esc(it.href || '#')}" class="sub${on ? ' on' : ''}" title="${esc(it.label)}" aria-label="${esc(it.label)}"${on ? ' aria-current="page"' : ''}><span class="sv">${glyph}</span><span>${esc(it.label)}</span>${countHtml({ value: it.count, kind: it.countKind })}</a>`;
      });
    });
    return h + '</div>';
  }

  const SETTINGS_NAV = {
    account: [
      { group: 'You' },
      { id: 'profile', label: 'Profile', icon: 'user' },
      { id: 'security', label: 'Sign-in & security', icon: 'shield' },
      { id: 'notifications', label: 'Notifications', icon: 'bell' },
      { group: 'Danger zone' },
      { id: 'danger', label: 'Delete account', icon: 'alert', danger: true },
    ],
    org: [
      { group: 'Organization' },
      { id: 'general', label: 'General', icon: 'building' },
      { id: 'members', label: 'Members & invites', icon: 'users' },
      { id: 'billing', label: 'Plan & billing', icon: 'card' },
      { id: 'usage', label: 'Usage & limits', icon: 'list' },
      { id: 'tokens', label: 'Token usage', icon: 'key' },
      { group: 'Danger zone' },
      { id: 'danger', label: 'Danger zone', icon: 'alert', danger: true },
    ],
    server: [
      { group: 'Server' },
      { id: 'overview', label: 'Overview', icon: 'server' },
      { id: 'users', label: 'Users & seats', icon: 'users' },
      { id: 'license', label: 'License', icon: 'key' },
      { group: 'Access' },
      { id: 'domains', label: 'Domains & access', icon: 'globe' },
      { id: 'signin', label: 'Sign-in methods', icon: 'lock' },
      { id: 'providers', label: 'Model providers', icon: 'agent' },
      { id: 'desktops', label: 'Linked Desktops', icon: 'laptop' },
      { group: 'Maintenance' },
      { id: 'storage', label: 'Storage & backups', icon: 'folderLine' },
      { id: 'updates', label: 'Updates', icon: 'clock' },
      { id: 'audit', label: 'Audit log', icon: 'list' },
    ],
  };
  // Cloud-only settings sections the server never offers.
  const CLOUD_ONLY_SETTINGS = new Set(['billing', 'servers']);
  const SETTINGS_HOME = { account: { label: 'Account settings', href: 'account.html#st=profile' }, org: { label: 'Organization settings', href: 'organization-settings.html#st=general' }, server: { label: 'Server administration', href: 'server-admin.html#st=overview' } };
  const SETTINGS_LABEL = { home: 'Home', chat: 'Chat', files: 'Files', passwords: 'Passwords', workflows: 'Workflows', agents: 'Agents', 'use-cases': 'Use Cases', organizations: 'Organizations' };

  function settingsHref(kind, id) {
    return `${kind === 'account' ? 'account.html' : kind === 'server' ? 'server-admin.html' : 'organization-settings.html'}#st=${id}`;
  }

  function normalizedPagePath(value) {
    const path = new URL(value, location.href).pathname.replace(/\/index(?:\.html)?$/, '').replace(/\.html$/, '');
    return path.length > 1 ? path.replace(/\/$/, '') : path;
  }

  function rememberSettingsFrom() {
    if (state.settings) return;
    try { sessionStorage.setItem('sulla_cloud_settings_from', JSON.stringify({ route: state.route, href: location.href, label: SETTINGS_LABEL[state.route] || 'Home' })); } catch (_) {}
  }

  function settingsFrom() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('sulla_cloud_settings_from') || 'null');
      if (saved?.href && saved?.label) return saved;
    } catch (_) {}
    return { href: 'index.html', label: 'Home' };
  }

  function renderSettingsNav() {
    const box = $('#navSettings');
    if (!box || !state.settings) return;
    const profile = api.profile() || {};
    const org = api.activeOrg();
    const from = settingsFrom();
    const items = (SETTINGS_NAV[state.settings] || []).filter((item) => !item.id || (!state.settingsHidden.has(item.id) && !CLOUD_ONLY_SETTINGS.has(item.id)));
    let h = `<a class="navback" href="${esc(from.href)}"><span class="sv">${ic('arrowLeft')}</span><span>Back to Sulla Server</span><span class="cnt">${esc(from.label)}</span></a>`;
    if (state.settings === 'account') {
      h += `<div class="brand"><div class="mark">${ic('user')}</div><div><b>Account settings</b><span>Follows you across organizations</span></div></div>`;
      h += `<div class="idcard"><span class="avatar">${esc(personInitials(profile))}</span><span class="t"><b>${esc(profile.name || profile.businessName || 'Your account')}</b><small>${esc(profile.email || '')}</small></span></div>`;
    } else if (state.settings === 'server') {
      h += `<div class="brand"><div class="mark">${ic('server')}</div><div><b>Server administration</b><span>Every organization on this server</span></div></div>`;
      h += `<div class="idcard"><span class="avatar sq">S</span><span class="t"><b>Sulla Server</b><small>${esc(serverHost())}</small></span></div>`;
    } else {
      h += `<div class="brand"><div class="mark">${ic('building')}</div><div><b>Organization settings</b><span>Scoped to this organization</span></div></div>`;
      h += `<button class="orgbtn" id="settingsOrgBtn" type="button" aria-haspopup="menu">${orgAvatar(org)}<span class="t"><b>${esc(org?.name || 'Organization')}</b><small>${esc(cap(org?.role || 'member'))}</small></span><span class="chev">${ic('chevDown')}</span></button>`;
    }
    let renderedItem = false;
    for (const item of items) {
      if (item.group) { h += `${renderedItem ? '<div class="sep"></div>' : ''}<div class="grp">${esc(item.group)}</div>`; continue; }
      const on = state.settingsActive === item.id;
      h += `<a class="item${item.danger ? ' danger' : ''}${on ? ' on' : ''}" href="${settingsHref(state.settings, item.id)}" title="${esc(item.label)}" aria-label="${esc(item.label)}"${on ? ' aria-current="page"' : ''}><span class="sv">${ic(item.icon)}</span><span>${esc(item.label)}</span></a>`;
      renderedItem = true;
    }
    const accountName = profile.name || profile.email || 'Your account';
    h += `<div class="sep settings-spacer"></div><button class="foot" id="settingsAccountBtn" type="button" title="${esc(accountName)}" aria-label="Account menu for ${esc(accountName)}"><span class="avatar">${esc(personInitials(profile))}</span><span class="foot-copy"><b>${esc(accountName)}</b><small>${esc(profile.email || '')}</small></span><span class="foot-chev">${ic('chevDown')}</span></button>`;
    box.innerHTML = h;
  }

  function renderNav() {
    const navId = ROUTES[state.route]?.nav;
    let h = '';
    for (const n of NAV) {
      const on = n.id === navId;
      const sub = on ? subnavHtml(n.id) : '';
      h += `<a href="${n.href}" class="${on ? 'on' : ''}${sub ? ' open' : ''}" title="${esc(n.label)}" aria-label="${esc(n.label)}"${on ? ' aria-current="page"' : ''}><span class="sv">${ic(n.icon)}</span><span>${n.label}</span>${countHtml(state.counts[n.id])}</a>${sub}`;
    }
    $('#navItems').innerHTML = h;
    renderSettingsNav();
  }

  function deviceIcon(d) {
    if (d.deviceType === 'mobile' || /ios|android|iphone/i.test(d.platform || '')) return 'phone';
    if (/mac ?mini|server/i.test(`${d.model || ''} ${d.name || ''}`)) return 'mini';
    return 'laptop';
  }

  function renderDevices() {
    const box = $('#navDevices');
    if (state.devices === null) {
      box.innerHTML = '<div class="devline skel"><span class="sv"></span><span class="n"></span></div>'.repeat(2);
      return;
    }
    if (state.devices === false) {
      box.innerHTML = '<div class="navnote">Devices could not load.</div>';
      return;
    }
    // Sulla Server itself: reachable, since this page just talked to it.
    let h = `<div class="devline"><span class="sv">${ic('server')}</span><span class="n">Sulla Server</span><span class="dot" title="Online"></span></div>`;
    const cutoff = Date.now() - 30 * 86400000;
    const older = state.devices.filter((d) => { const t = parseDate(d.lastSeenAt)?.getTime(); return !d.online && t && t < cutoff; });
    h += state.devices.filter((d) => !older.includes(d)).map((d) => `<a class="devline ${d.online ? '' : 'off'}" href="devices.html#id=${encodeURIComponent(d.id)}" title="${esc(`${d.name} · ${d.online ? 'Online' : `Last seen ${localWhen(d.lastSeenAt)}`}`)}" aria-label="${esc(`${d.name} · ${d.online ? 'Online' : 'Offline'}`)}"><span class="sv">${ic(deviceIcon(d))}</span><span class="n">${esc(d.name)}</span><span class="dot ${d.online ? '' : 'off'}"></span></a>`).join('');
    if (older.length) h += `<div id="older-devices" ${state.showOlder ? '' : 'hidden'}>${older.map((d) => `<a class="devline off" href="devices.html#id=${encodeURIComponent(d.id)}" title="${esc(`${d.name} · Last seen ${localWhen(d.lastSeenAt)}`)}" aria-label="${esc(`${d.name} · Offline`)}"><span class="sv">${ic(deviceIcon(d))}</span><span class="n">${esc(d.name)}</span><span class="dot off"></span></a>`).join('')}</div>`;
    if (older.length) h += `<button class="navnote older-toggle" type="button" data-show-older aria-expanded="${state.showOlder}" aria-controls="older-devices">${state.showOlder ? 'Hide' : `Show ${older.length}`} older device${older.length === 1 ? '' : 's'}</button>`;
    if (!state.devices.length) h += '<div class="navnote">No devices in this organization yet.</div>';
    box.innerHTML = h;
  }

  function renderOrgButton() {
    const org = api.activeOrg();
    const btn = $('#orgBtn');
    if (!org) {
      btn.innerHTML = `<span class="avatar sq a">?</span><span class="t"><b>No organization</b><small>Create one to start</small></span>`;
      return;
    }
    const memberCount = state.memberCount ?? org.memberCount;
    const subtitle = `${cap(org.role)}${Number.isFinite(Number(memberCount)) ? ` · ${Number(memberCount)} member${Number(memberCount) === 1 ? '' : 's'}` : ''}`;
    btn.innerHTML = `${orgAvatar(org)}<span class="t"><b>${esc(org.name)}</b><small>${esc(subtitle)}</small></span><span class="chev">${ic('chevDown')}</span>`;
    btn.setAttribute('aria-label', `Organization: ${org.name}. Switch organization`);
  }

  function renderFoot() {
    const profile = api.profile();
    const nOrgs = api.orgs().length;
    const nDev = Array.isArray(state.devices) ? state.devices.length : null;
    const bits = [`${nOrgs} organization${nOrgs === 1 ? '' : 's'}`];
    if (nDev !== null) bits.push(`${nDev} device${nDev === 1 ? '' : 's'}`);
    $('#accountBtn').innerHTML = `<span class="avatar">${esc(personInitials(profile))}</span><span><b>${esc(profile?.name || profile?.email || 'Your account')}</b><small>${esc(bits.join(' · '))}</small></span>`;
  }

  function renderCrumbs() {
    const org = api.activeOrg();
    const route = ROUTES[state.route];
    const settingsItem = state.settings ? (SETTINGS_NAV[state.settings] || []).find((item) => item.id === state.settingsActive) : null;
    const trail = state.settings
      ? [...(state.settings === 'org' && org ? [{ label: org.name, href: 'organizations.html' }] : []), SETTINGS_HOME[state.settings], { label: settingsItem?.label || route.title }]
      : (state.crumbs || route.crumbs || [{ label: route.title }]);
    let h = !state.settings && org ? `<a class="c" href="organizations.html">${esc(org.name)}</a><span>›</span>` : '';
    trail.forEach((c, i) => {
      const last = i === trail.length - 1;
      h += last ? `<b>${esc(c.label)}</b>` : `<a class="c" href="${esc(c.href || '#')}">${esc(c.label)}</a><span>›</span>`;
    });
    $('#crumbs').innerHTML = h;
    document.title = `${trail[trail.length - 1].label} · Sulla Server`;
  }

  function renderOrgPop() {
    const orgs = api.orgs();
    let h = '<div class="hd">Switch organization</div>';
    h += orgs.map((o) => `<button class="it" type="button" role="menuitemradio" aria-checked="${o.active}" data-org="${esc(o.id)}">${orgAvatar(o)}<span class="t"><b>${esc(o.name)}</b><small>${esc(cap(o.role))}</small></span>${o.active ? `<span class="ck">${ic('check')}</span>` : ''}</button>`).join('');
    if (!orgs.length) h += '<div class="hint">You are not in an organization yet.</div>';
    h += `<div class="ms"></div><button class="ln" type="button" data-settings-href="organization-settings.html#st=general"><span>${ic('settings')}</span>Organization settings</button><button class="ln" type="button" data-href="organizations.html"><span>${ic('building')}</span>Manage organizations</button><button class="ln" type="button" data-href="organizations.html#link"><span>${ic('plus')}</span>Link another organization</button>`;
    $('#orgPop').innerHTML = h;
  }

  function renderThemeBox(root = document) {
    const theme = window.CloudTheme.get();
    root.querySelectorAll('[data-theme-scheme]').forEach((sel) => {
      sel.value = theme.scheme;
      const label = sel.parentElement.querySelector('[data-theme-label]');
      if (label) label.textContent = sel.selectedOptions[0]?.text || '';
    });
    root.querySelectorAll('[data-mode]').forEach((b) => {
      const on = b.dataset.mode === theme.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function themeBoxHtml() {
    const opts = window.CloudTheme.SCHEMES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
    return `<div class="themebox" title="Theme: the same token sets Sulla Desktop ships">
      <label class="sel"><span>Theme</span> <b data-theme-label></b><select data-theme-scheme aria-label="Theme">${opts}</select></label>
      <div class="seg" role="group" aria-label="Mode"><button type="button" data-mode="light"><span class="bi">${ic('sun')}</span>Light</button><button type="button" data-mode="dark"><span class="bi">${ic('moon')}</span>Dark</button></div>
    </div>`;
  }

  function renderChrome() {
    document.body.classList.remove('is-signin');
    renderNav();
    renderDevices();
    renderOrgButton();
    renderFoot();
    renderCrumbs();
    renderOrgPop();
  }

  function cap(s) {
    const v = String(s || '');
    return v ? v[0].toUpperCase() + v.slice(1) : '';
  }

  // ── Layout ────────────────────────────────────────────────────────────
  function shellHtml() {
    return `<div class="app${state.settings ? ' in-settings' : ''}" id="app">
      <div class="navwrap"><nav class="nav nav-main" aria-label="Sulla Server">
        <div class="brand"><div class="mark">S</div><div><b>Sulla Server</b><span>${esc(serverHost())} · web</span></div></div>
        <button class="orgbtn" id="orgBtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="orgPop"></button>
        <div id="navItems"></div>
        <div class="sep"></div>
        <div class="grp">Your devices</div>
        <div id="navDevices"></div>
        <button class="foot" id="accountBtn" type="button" aria-haspopup="menu" aria-expanded="false"></button>
      </nav><nav class="nav nav-settings" id="navSettings" aria-label="Settings"></nav></div>
      <div class="maincol">
        <header class="top">
          <div class="crumbs" id="crumbs"></div>
          <button class="search" id="commandTrigger" type="button" aria-label="Go to a page or device" aria-haspopup="dialog"><span class="si">${ic('search')}</span><span class="command-trigger-copy">Go to a page or device</span><kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd></button>
          <div class="acts">${themeBoxHtml()}</div>
        </header>
        <main class="view" id="view"></main>
      </div>
    </div>
    <div class="pop" id="orgPop" role="menu" aria-label="Organizations"></div>
    <div class="pop" id="accountPop" role="menu" aria-label="Account"></div>
    <div id="commandRoot"></div>
    <div class="toast" id="toast" role="status" aria-live="polite"><span class="dot"></span><span id="toastMsg"></span></div>`;
  }

  // ── Command palette ───────────────────────────────────────────────────
  function commandItems() {
    const destinations = [...NAV.map((item) => ({ ...item, group: 'Navigate' })), { id: 'devices', label: 'Devices', icon: 'laptop', href: 'devices.html', group: 'Navigate' }, ...(window.SullaServerPages || [])];
    const devices = Array.isArray(state.devices) ? state.devices.map((device) => ({
      id: `device-${device.id}`, label: device.name, icon: deviceIcon(device),
      href: `devices.html#id=${encodeURIComponent(device.id)}`, group: 'Devices',
      meta: device.online ? 'Online' : 'Offline',
    })) : [];
    return [...destinations, ...devices].filter((item) => item.label.toLowerCase().includes(state.commandQuery.toLowerCase()));
  }

  function renderCommandPalette() {
    const root = $('#commandRoot');
    if (!root) return;
    if (!state.commandOpen) { root.replaceChildren(); return; }
    const items = commandItems();
    state.commandIndex = Math.max(0, Math.min(state.commandIndex, Math.max(0, items.length - 1)));
    let group = '';
    const rows = items.map((item, index) => {
      const heading = item.group !== group ? `<div class="command-group">${esc(item.group)}</div>` : '';
      group = item.group;
      return `${heading}<button class="command-option" type="button" role="option" aria-selected="${index === state.commandIndex}" data-command-index="${index}" data-command-href="${esc(item.href)}"><span class="sv">${ic(item.icon)}</span><span>${esc(item.label)}</span>${item.meta ? `<small>${esc(item.meta)}</small>` : ''}</button>`;
    }).join('');
    root.innerHTML = `<div class="command-backdrop" data-command-close><section class="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><label class="command-input"><span class="sv">${ic('search')}</span><input type="search" autocomplete="off" aria-label="Search destinations and devices" placeholder="Go to a page or device" value="${esc(state.commandQuery)}"></label><div class="command-list" role="listbox">${rows || '<div class="command-empty">No matching destinations.</div>'}</div></section></div>`;
    const input = root.querySelector('input');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function openCommandPalette() {
    if (state.commandOpen) return;
    state.commandReturnFocus = document.activeElement;
    state.commandOpen = true;
    state.commandIndex = 0;
    state.commandQuery = '';
    closePops();
    renderCommandPalette();
  }

  function closeCommandPalette() {
    if (!state.commandOpen) return;
    state.commandOpen = false;
    renderCommandPalette();
    state.commandReturnFocus?.focus?.();
  }

  function navigateCommand(index = state.commandIndex) {
    const item = commandItems()[index];
    if (item) location.href = item.href;
  }

  function renderFileShellEmpty() {
    if (state.route !== 'files') return false;
    const section = new URLSearchParams(location.hash.replace(/^#/, '')).get('sec');
    const copy = section === 'starred'
      ? { title: 'Starred', icon: 'star', body: "Starred files aren't available on this server yet." }
      : section === 'agent'
        ? { title: 'Agent files', icon: 'agent', body: 'Files your agents create will appear here once your Desktop syncs them.' }
        : null;
    if (!copy) return false;
    const view = $('#view');
    view.innerHTML = `<div class="files-shell-empty"><div class="page-head"><div><h1>${copy.title}</h1><p>${esc(api.activeOrg()?.name || '')}</p></div></div><div class="card" data-shell-empty></div></div>`;
    states.empty(view.querySelector('[data-shell-empty]'), { icon: copy.icon, title: `No ${copy.title.toLowerCase()} yet`, body: copy.body });
    return true;
  }

  // ── Popovers ──────────────────────────────────────────────────────────
  function placePop(pop, anchor, above) {
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    if (above) {
      pop.style.top = '';
      pop.style.bottom = `${window.innerHeight - r.top + 6}px`;
    } else {
      pop.style.bottom = '';
      pop.style.top = `${r.bottom + 6}px`;
    }
  }

  function togglePop(id, anchorId, open, above) {
    const pop = document.getElementById(id);
    const anchor = document.getElementById(anchorId);
    const next = open === undefined ? !pop.classList.contains('open') : open;
    if (next) placePop(pop, anchor, above);
    pop.classList.toggle('open', next);
    anchor.setAttribute('aria-expanded', String(next));
    if (next) pop.querySelector('button')?.focus();
  }

  function closePops() {
    ['orgPop', 'accountPop'].forEach((id) => document.getElementById(id)?.classList.remove('open'));
    $('#orgBtn')?.setAttribute('aria-expanded', 'false');
    $('#accountBtn')?.setAttribute('aria-expanded', 'false');
  }

  function renderAccountPop() {
    const profile = api.profile() || {};
    const org = api.activeOrg();
    const dark = window.CloudTheme.get().mode === 'dark';
    $('#accountPop').innerHTML = `<div class="ph"><span class="avatar">${esc(personInitials(profile))}</span><span class="t"><b>${esc(profile.name || profile.email || 'Your account')}</b><small>${esc(profile.email || '')}</small></span></div>
      <button class="ln" type="button" data-settings-href="account.html#st=profile"><span>${ic('user')}</span>Account settings</button>
      <button class="ln" type="button" data-settings-href="account.html#st=notifications"><span>${ic('bell')}</span>Notifications</button><div class="ms"></div>
      <button class="ln" type="button" data-settings-href="organization-settings.html#st=general"><span>${ic('building')}</span>Organization settings<span class="tr">${esc(org?.name || '')}</span></button>
      <button class="ln" type="button" data-href="organizations.html"><span>${ic('building')}</span>Switch organization<span class="tr">${api.orgs().length}</span></button>
      ${profile.isServerAdmin === true ? `<button class="ln" type="button" data-settings-href="server-admin.html#st=overview"><span>${ic('server')}</span>Server administration</button>` : ''}
      <button class="ln" type="button" data-mode="${dark ? 'light' : 'dark'}"><span>${ic(dark ? 'sun' : 'moon')}</span>${dark ? 'Light' : 'Dark'} mode<span class="tr">${dark ? 'Dark' : 'Light'}</span></button><div class="ms"></div>
      <button class="ln danger" type="button" data-signout><span>${ic('close')}</span>Sign out</button>`;
  }

  // ── Org switching ─────────────────────────────────────────────────────
  async function onPickOrg(button) {
    const id = button.dataset.org;
    const org = api.orgs().find((o) => o.id === id);
    if (!org || org.active) { closePops(); return; }
    document.querySelectorAll('#orgPop [data-org]').forEach((b) => { b.disabled = true; });
    $('#orgBtn').disabled = true;
    try {
      await api.switchOrg(id); // onOrgChange below redraws and reloads
      closePops();
      toast(`Switched to ${org.name}.`);
    } catch (error) {
      console.error('[cloud] org switch failed', error);
      toast('That organization could not be opened. Nothing changed.');
      renderOrgPop();
    } finally {
      $('#orgBtn').disabled = false;
    }
  }

  async function loadOrgMemberCount() {
    state.memberCount = null;
    const org = api.activeOrg();
    if (!org) { renderOrgButton(); return; }
    if (org.memberCount !== null && org.memberCount !== undefined) { state.memberCount = Number(org.memberCount); renderOrgButton(); return; }
    try {
      const response = await api.get(`/teams/${encodeURIComponent(org.id)}/members`);
      const members = response?.members || response?.data?.members;
      if (Array.isArray(members)) state.memberCount = members.length;
    } catch (_) {
      // The subtitle stays honest (role only) when this API is unavailable.
    }
    renderOrgButton();
  }

  async function loadDevices() {
    state.devices = null;
    renderDevices();
    try {
      state.devices = await api.listDevices();
    } catch (error) {
      if (error?.status === 401) return;
      state.devices = false;
    }
    renderDevices();
    renderFoot();
  }

  // ── Screen body ───────────────────────────────────────────────────────
  function context() {
    return { view: $('#view'), org: api.activeOrg(), profile: api.profile(), api, states, shell: window.CloudShell };
  }

  function renderComingSoon() {
    const route = ROUTES[state.route];
    const view = $('#view');
    view.innerHTML = `<div class="content soon">
      <div class="page-head"><div><h1>${esc(route.title === 'Run' ? 'Workflow run' : route.title)}</h1><p>${esc(api.activeOrg()?.name || '')}</p></div></div>
      <div class="card"><div data-soon></div></div>
    </div>`;
    const body = view.querySelector('[data-soon]');
    states.empty(body, {
      icon: NAV.find((n) => n.id === route.nav)?.icon || 'note',
      title: 'Not connected yet',
      body: 'This screen is part of the new Sulla Server app and is still being built. Nothing below is shown until it reads your real data.',
    });
    const list = document.createElement('ul');
    route.soon.forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    });
    body.firstElementChild.appendChild(list);
  }

  async function mountScreen() {
    if (!state.screen) { renderComingSoon(); return; }
    states.loading($('#view'));
    try {
      await state.screen.mount(context());
    } catch (error) {
      console.error('[cloud] screen failed to load', error);
      states.error($('#view'), error, { retry: mountScreen });
    }
  }

  function renderNoOrg() {
    const view = $('#view');
    view.innerHTML = '<div class="content"><div class="card" data-noorg></div></div>';
    const box = view.querySelector('[data-noorg]');
    states.empty(box, {
      icon: 'building',
      title: 'You are not in an organization yet',
      body: 'Everything in Sulla Server belongs to an organization. Create one, or ask someone to invite you to theirs.',
      actions: [{ label: 'Create organization', primary: true, onClick: () => showCreateOrg(box) }],
    });
  }

  function showCreateOrg(box) {
    box.innerHTML = `<form class="state" data-create-org>
      <div class="state-ico">${ic('building')}</div>
      <b>Name your organization</b>
      <input class="field" name="name" maxlength="80" required placeholder="Organization name" style="max-width:320px" autocomplete="organization">
      <div class="state-acts"><button class="btn pri" type="submit">Create</button></div>
      <span class="err" style="color:var(--bad);font-size:12px" role="alert"></span>
    </form>`;
    const form = box.querySelector('form');
    form.name.focus();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.name.value.trim();
      if (!name) return;
      form.querySelector('button').disabled = true;
      try {
        await api.createOrg(name); // the org-change reload mounts the screen
      } catch (error) {
        form.querySelector('.err').textContent = states.errorText(error) || 'That did not work. Try again.';
        form.querySelector('button').disabled = false;
      }
    });
  }

  // ── Sign in ───────────────────────────────────────────────────────────
  function renderSignIn(message) {
    document.title = 'Sign in · Sulla Server';
    document.body.classList.add('is-signin');
    document.body.innerHTML = `<div class="signin"><div class="signin-card">
      <div class="brand"><div class="mark">S</div><div><b>Sulla Server</b><span>${esc(serverHost())}</span></div></div>
      <h1>Sign in</h1>
      <p>Use the email address your invitation was sent to.</p>
      <div class="seg" role="tablist" aria-label="Sign-in method">
        <button type="button" role="tab" data-method="code" class="on">Email code</button>
        <button type="button" role="tab" data-method="password">Password</button>
      </div>
      <form data-form novalidate></form>
      <div class="err" role="alert" data-err>${esc(message || '')}</div>
      <p class="signin-new">No account? Ask your administrator for an invitation.</p>
      <nav class="signin-links" aria-label="Sulla links"><a href="https://sulladesktop.com/support.html">Help</a><a href="https://sulladesktop.com/privacy.html">Privacy</a><a href="https://sulladesktop.com/terms.html">Terms</a></nav>
      ${themeBoxHtml()}
    </div></div>
    <div class="toast" id="toast" role="status" aria-live="polite"><span class="dot"></span><span id="toastMsg"></span></div>`;
    renderThemeBox();
    const card = $('.signin-card');
    const form = card.querySelector('[data-form]');
    const err = card.querySelector('[data-err]');
    let method = 'code';
    let pending = null; // email or phone waiting for a code

    async function enableApple() {
      const button = card.querySelector('[data-apple]');
      try {
        const config = await api.signIn.appleConfig();
        if (!config?.enabled || !config.clientId) return;
        button.hidden = false;
        button.addEventListener('click', async () => {
          button.disabled = true; err.textContent = '';
          let popup = null;
          try {
            const started = await api.send('POST', '/oauth/start', { provider: 'apple', returnTo: 'sulla-cloud' });
            popup = window.open(started.authorizeUrl, 'sulla-apple-sign-in', 'popup,width=560,height=720');
            if (!popup) throw new Error('Allow pop-ups to sign in with Apple.');
            for (let attempt = 0; attempt < 120; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              const result = await api.request(`/oauth/result/${encodeURIComponent(started.state)}`, { headers: { 'X-OAuth-Poll': started.pollToken } });
              if (result.status === 'pending') continue;
              if (result.status !== 'done' || !result.result?.sullaSession) throw new Error(result.error || 'Apple Sign-In did not finish.');
              const session = result.result.sullaSession;
              api.signIn.setTokens(session.accessToken, session.refreshToken);
              popup.close(); location.reload(); return;
            }
            throw new Error('Apple Sign-In timed out.');
          } catch (error) { try { popup?.close(); } catch (_) {} err.textContent = error?.message || 'Apple Sign-In failed.'; }
          finally { if (button.isConnected) button.disabled = false; }
        });
      } catch (_) { /* Apple is optional when the backend is not configured. */ }
    }

    function draw() {
      card.querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('on', b.dataset.method === method));
      if (method === 'password') {
        form.innerHTML = `<label>Email<input class="field" name="email" type="email" autocomplete="email" required></label>
          <label>Password<input class="field" name="password" type="password" autocomplete="current-password" required></label>
          <button class="btn pri" type="submit">Sign in</button>`;
      } else if (!pending) {
        form.innerHTML = method === 'code'
          ? `<label>Email<input class="field" name="target" type="email" autocomplete="email" placeholder="you@example.com" required></label><button class="btn pri" type="submit">Email me a code</button>`
          : `<label>Phone number<input class="field" name="target" type="tel" inputmode="tel" autocomplete="tel" placeholder="+1 208 555 0123" required></label><button class="btn pri" type="submit">Text me a code</button>`;
      } else {
        form.innerHTML = `<p class="muted" style="margin:0;font-size:12.5px">We sent a code to <b></b>. <button type="button" class="linkish" data-edit>Change</button></p>
          <label>Verification code<input class="field" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required></label>
          <button class="btn pri" type="submit">Verify and sign in</button>`;
        form.querySelector('p b').textContent = pending;
        form.querySelector('[data-edit]').addEventListener('click', () => { pending = null; draw(); });
      }
      form.querySelector('input')?.focus();
    }

    card.querySelectorAll('[data-method]').forEach((b) => b.addEventListener('click', () => {
      method = b.dataset.method;
      pending = null;
      err.textContent = '';
      draw();
    }));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      err.textContent = '';
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      try {
        let res;
        if (method === 'password') {
          res = await api.signIn.emailLogin(form.email.value.trim(), form.password.value);
        } else if (!pending) {
          const target = form.target.value.trim();
          res = method === 'code' ? await api.signIn.emailCodeStart(target) : await api.signIn.sendOtp(target);
          if (res?.ok) { pending = target; draw(); return; }
        } else {
          const code = form.code.value.trim();
          res = method === 'code' ? await api.signIn.emailCodeVerify(pending, code) : await api.signIn.verifyOtp(pending, code);
        }
        if (!res?.ok) { err.textContent = res?.error || 'That did not work. Try again.'; return; }
        if (method === 'password' || pending) location.reload();
      } catch (error) {
        err.textContent = states.errorText(error) || 'That did not work. Try again.';
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
    });
    draw();
  }

  // ── Toast ─────────────────────────────────────────────────────────────
  function toast(message) {
    const t = $('#toast');
    if (!t) return;
    $('#toastMsg').textContent = message;
    t.classList.add('open');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('open'), 2600);
  }

  // ── Events ────────────────────────────────────────────────────────────
  function wire() {
    document.addEventListener('click', (event) => {
      const t = event.target.closest('#orgBtn, #settingsOrgBtn, #accountBtn, #settingsAccountBtn, #commandTrigger, [data-command-href], [data-command-close], [data-org], [data-href], [data-settings-href], [data-signout], [data-mode], [data-show-older], .nav-settings a.item');
      if (!t) {
        if (!event.target.closest('.pop')) closePops();
        return;
      }
      if (t.id === 'commandTrigger') { openCommandPalette(); return; }
      if (t.dataset.commandHref) { navigateCommand(Number(t.dataset.commandIndex)); return; }
      if (t.hasAttribute('data-command-close') && event.target === t) { closeCommandPalette(); return; }
      if (t.id === 'orgBtn' || t.id === 'settingsOrgBtn') { closePops(); renderOrgPop(); togglePop('orgPop', t.id, true); return; }
      if (t.id === 'accountBtn' || t.id === 'settingsAccountBtn') { closePops(); renderAccountPop(); togglePop('accountPop', t.id, true, true); return; }
      if (t.dataset.org) { onPickOrg(t); return; }
      if (t.matches('.nav-settings a.item')) { const next = new URL(t.href, location.href); if (normalizedPagePath(next.href) === normalizedPagePath(location.href)) { event.preventDefault(); location.hash = next.hash; } return; }
      if (t.dataset.settingsHref) { rememberSettingsFrom(); const next = new URL(t.dataset.settingsHref, location.href); if (normalizedPagePath(next.href) === normalizedPagePath(location.href)) location.hash = next.hash; else location.href = t.dataset.settingsHref; return; }
      if (t.dataset.href) { location.href = t.dataset.href; return; }
      if (t.hasAttribute('data-signout')) {
        ask({ title: 'Sign out of Sulla Server?', body: 'You can sign back in at any time.', okLabel: 'Sign out', danger: true }).then((yes) => { if (yes) api.signOut().finally(() => location.reload()); });
        return;
      }
      if (t.dataset.mode) window.CloudTheme.set({ mode: t.dataset.mode });
      if (t.matches('[data-show-older]')) { state.showOlder = !state.showOlder; renderDevices(); }
    });
    document.addEventListener('input', (event) => {
      if (!event.target.closest('.command-input')) return;
      state.commandQuery = event.target.value;
      state.commandIndex = 0;
      renderCommandPalette();
    });
    document.addEventListener('change', (event) => {
      if (event.target.matches('[data-theme-scheme]')) window.CloudTheme.set({ scheme: event.target.value });
    });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); return; }
      if (!state.commandOpen) { if (event.key === 'Escape') closePops(); return; }
      if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const length = commandItems().length;
        if (length) state.commandIndex = (state.commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + length) % length;
        renderCommandPalette();
        return;
      }
      if (event.key === 'Enter') { event.preventDefault(); navigateCommand(); }
    });
    window.addEventListener('resize', closePops);
    window.addEventListener('hashchange', (event) => { if ($('#navItems')) renderNav(); if (renderFileShellEmpty()) event.stopImmediatePropagation(); });
    window.CloudTheme.onChange(() => renderThemeBox());

    // Show a scroll area's thumb while it is scrolling, even without hover.
    document.addEventListener('scroll', (event) => {
      const el = event.target === document ? document.scrollingElement : event.target;
      if (!el || !el.classList) return;
      el.classList.add('is-scrolling');
      clearTimeout(el._scrollIdle);
      el._scrollIdle = setTimeout(() => el.classList.remove('is-scrolling'), 900);
    }, { capture: true, passive: true });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    const route = document.body.dataset.route;
    state.route = ROUTES[route] ? route : 'home';
    wire();

    if (!api.isSignedIn()) { renderSignIn(); return; }

    const curtain = document.createElement('div');
    curtain.className = 'boot';
    curtain.innerHTML = '<div class="state loading"><span class="spinner"></span><span>Opening Sulla Server…</span></div>';
    document.body.appendChild(curtain);

    let needsOrg = false;
    try {
      await api.loadProfile();
      ({ needsOrg } = await api.ensureOrg());
      await api.loadTeams();
      if (state.settings && !sessionStorage.getItem('sulla_cloud_settings_from')) rememberSettingsFrom();
    } catch (error) {
      curtain.remove();
      if (error?.status === 401 || !api.isSignedIn()) { renderSignIn('Your session ended. Sign in again.'); return; }
      states.error(document.body, error, { title: 'Sulla Server could not open', retry: () => location.reload() });
      return;
    }

    document.body.insertAdjacentHTML('afterbegin', shellHtml());
    renderThemeBox();
    renderChrome();
    loadOrgMemberCount();
    curtain.remove();

    api.onSessionExpired(() => renderSignIn('Your session ended. Sign in again.'));
    api.onOrgChange(() => { state.crumbs = null; state.memberCount = null; renderChrome(); loadOrgMemberCount(); loadDevices(); });

    if (needsOrg && state.settings !== 'account') {
      state.devices = [];
      renderChrome();
      renderNoOrg();
      api.registerModel(mountScreen);
      return;
    }

    loadDevices();
    if (state.screen) {
      const reload = state.screen.reload || state.screen.mount;
      api.registerModel(async () => {
        try { await reload(context()); } catch (error) { states.error($('#view'), error, { retry: mountScreen }); }
      });
    } else {
      api.registerModel(renderComingSoon);
    }
    await mountScreen();
    renderFileShellEmpty();
  }

  // In-app replacement for window.prompt/confirm (native dialogs block the
  // page and do not match the theme). Resolves to the typed text (input
  // mode), true (confirm mode) or null when cancelled.
  function ask({ title, body = '', input = false, value = '', placeholder = '', okLabel = 'OK', danger = false, initialFocus } = {}) {
    return new Promise((resolve) => {
      const trigger = document.activeElement;
      const wrap = document.createElement('div');
      const titleId = `cloud-dialog-title-${Date.now()}`;
      wrap.className = 'modal-backdrop open';
      wrap.innerHTML = `<form class="action-modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <h2 id="${titleId}">${esc(title)}</h2>
        ${body ? `<p class="dim">${esc(body)}</p>` : ''}
        ${input ? `<input class="field" name="value" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}">` : ''}
        <div class="modal-actions">
          <button class="btn" type="button" data-cancel>Cancel</button>
          <button class="btn ${danger ? 'danger' : 'pri'}" type="submit">${esc(okLabel)}</button>
        </div>
      </form>`;
      const done = (result) => { wrap.remove(); document.removeEventListener('keydown', onKey); trigger?.focus?.(); resolve(result); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-cancel]')) done(null); });
      wrap.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input) return done(true);
        const text = wrap.querySelector('input[name=value]').value.trim();
        if (text) done(text);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      const focusTarget = input ? wrap.querySelector('input[name=value]') : initialFocus === 'submit' ? wrap.querySelector('[type=submit]') : initialFocus === 'cancel' || danger ? wrap.querySelector('[data-cancel]') : wrap.querySelector('[type=submit]');
      focusTarget.focus();
    });
  }


  window.CloudShell = {
    routes: ROUTES,
    // Register the screen for this page. Call before DOMContentLoaded (a
    // deferred script after shell.js is fine).
    screen(def) {
      state.settings = def?.settings || null;
      if (state.settings && !['account', 'org', 'server'].includes(state.settings)) throw new Error('CloudShell.screen settings must be account, org or server.');
      if (!def || typeof def.mount !== 'function') throw new Error('CloudShell.screen needs a mount(ctx) function.');
      state.screen = def;
    },
    settingsNav(activeId, { hidden = [] } = {}) {
      state.settingsActive = activeId;
      state.settingsHidden = new Set(hidden);
      if ($('#navSettings')) renderSettingsNav();
      if ($('#crumbs')) renderCrumbs();
    },
    async refreshProfile() {
      await api.loadProfile();
      renderFoot();
      renderSettingsNav();
      renderAccountPop();
    },
    async refreshDevices() {
      await loadDevices();
    },
    async refreshOrg(updatedOrg) {
      await Promise.all([api.loadProfile(), api.loadTeams()]);
      const active = api.activeOrg();
      if (updatedOrg?.name && active?.id === updatedOrg.id && active.name !== updatedOrg.name) {
        const membership = api.profile()?.memberships?.find((item) => item.teamId === active.id);
        if (membership) membership.teamName = updatedOrg.name;
      }
      renderOrgButton();
      renderOrgPop();
      renderSettingsNav();
      renderCrumbs();
      if (state.screen) {
        const ctx = context();
        ctx.org = api.activeOrg();
      }
    },
    rememberSettingsFrom,
    setNavCount(navId, value, kind = '') {
      state.counts[navId] = { value, kind };
      if ($('#navItems')) renderNav();
    },
    setSubnav(navId, groups) {
      state.subnav[navId] = groups;
      if ($('#navItems')) renderNav();
    },
    setCrumbs(trail) {
      state.crumbs = Array.isArray(trail) && trail.length ? trail : null;
      if ($('#crumbs')) renderCrumbs();
    },
    toast,
    ask,
    esc,
    parseDate,
    localWhen,
  };

  // Wait for DOMContentLoaded even when this script runs deferred: deferred
  // screen scripts after it must register first. The load listener covers a
  // late injection after DOMContentLoaded has already fired.
  let booted = false;
  const start = () => { if (!booted) { booted = true; boot(); } };
  if (document.readyState === 'complete') start();
  else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('load', start, { once: true });
  }
})();
