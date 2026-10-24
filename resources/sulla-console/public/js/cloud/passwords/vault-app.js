import { renderFilesBackup } from './files-backup-view.js';
// Sulla Server · Passwords (vault origin): the vault console screen.
//
// Layout is the Sulla Desktop vault console port from the approved mockup:
// the vault's sections live in the main nav under Passwords (setSubnav).
// Every value comes from the user's own encrypted vault, decrypted in the
// crypto worker after they type the master password here. States:
//   off       Desktop > Profile sync is off (or the Cloud copy was deleted)
//   locked    ciphertext prefetched; waiting for the master password
//   unlocked  list/detail, editor, audit log, settings
// Lock, sign-out, 15 min idle, 5 min hidden, pagehide, a bfcache restore, a
// 401, a deleted copy or a newer bundle all wipe the worker and the DOM.

import { createVaultClient } from './vault-client.js';

const shell = window.CloudShell;
const esc = shell.esc;
const IDLE_MS = 15 * 60 * 1000;
const HIDDEN_MS = 5 * 60 * 1000;
const STATUS_POLL_MS = 60 * 1000;
const CLIPBOARD_MS = 30 * 1000;
const MAX_FAILS = 5;
const BACKOFF_MS = 30 * 1000;

const vi = (p) => `<svg class="i" aria-hidden="true" viewBox="0 0 24 24">${p}</svg>`;
const vism = (p) => `<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24">${p}</svg>`;
const VP = {
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  star: '<path d="M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.8 1-5.8L3.6 9.9l5.8-.8z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2.5 2.5M14 9l2 2"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
  note: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14 10h4M14 13.5h3"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.6 3 8.3 7 9.5 4-1.2 7-4.9 7-9.5V6z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>',
  agent: '<rect x="5" y="7" width="14" height="12" rx="3"></rect><path d="M9 4v3m6-3v3M8 12h.01M12 12h.01M16 12h.01M9 16h6"></path>',
  agent2: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 17h5"/><circle cx="12" cy="3.5" r="1"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  chev: '<path d="m9 6 6 6-6 6"/>', check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  server: '<path d="M4 7h16v12H4zM8 4h8M8 10h.01M12 10h.01M16 10h.01"></path>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7H7z"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
};
const TYPES = [['login', 'Logins', VP.globe, 'Login'], ['apiKey', 'API keys & tokens', VP.key, 'API key'], ['card', 'Cards', VP.card, 'Card'], ['note', 'Secure notes', VP.note, 'Secure note'], ['identity', 'Identities', VP.id, 'Identity']];
const typeLabel = (t) => TYPES.find((x) => x[0] === t)?.[3] || 'Item';
const CF_TYPES = [['text', 'Text'], ['multiline', 'Long text'], ['password', 'Password'], ['url', 'Website / URL'], ['email', 'Email'], ['number', 'Number'], ['date', 'Date'], ['phone', 'Phone'], ['one-time', 'One-time code (TOTP)'], ['boolean', 'Yes / No']];
const LEVELS = [
  ['metadata', 'Metadata', 'See that this login exists (name, website, username) so they can ask you for it. <em>Can\'t use the password.</em>'],
  ['autofill', 'Autofill', 'Sign in and call tools with it. Sulla fills it in behind the scenes. <em>The agent never sees the password.</em>'],
  ['full', 'Full', 'Read the actual value. Only for tools that need the raw key. <em>The value can end up in the agent\'s chat.</em>'],
];
const DEFAULT_POLICY = { mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false };
const AUDIT_LABELS = {
  sync_enabled: 'Turned on sync', sync_paused: 'Paused sync', sync_resumed: 'Resumed sync', cloud_copy_deleted: 'Deleted the vault',
  bundle_created: 'Uploaded the vault', bundle_rewrapped: 'Changed the master password', account_key_rotated: 'Rotated the account key',
  commit_accepted: 'Saved changes', commit_conflict: 'Change conflicted', bundle_downloaded: 'Downloaded the vault', records_downloaded: 'Downloaded items',
  sync_signature_rejected: 'Rejected a bad device signature', device_revoked_rejected: 'Rejected a removed device', validator_rejected: 'Rejected a malformed upload',
  browser_session_started: 'Opened the vault page', browser_session_ended: 'Signed out of the vault page', browser_reauthenticated: 'Confirmed with an email code',
};
const BLOCKED = new Set(['sync_signature_rejected', 'device_revoked_rejected', 'validator_rejected', 'commit_conflict']);

function initials(name) {
  const word = (String(name).match(/[\p{L}\p{N}]+/u) || ['--'])[0];
  const inner = word.slice(1).match(/\p{Lu}/u)?.[0];
  return (word[0] + (inner || word[1] || '')).toUpperCase();
}
function tint(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 5 ? ` c${h % 5 + 1}` : '';
}
function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
const parseHash = () => new URLSearchParams(location.hash.replace(/^#/, ''));

// ── State ───────────────────────────────────────────────────────────────
const client = createVaultClient();
const ui = {
  ctx: null,
  phase: 'loading', // loading | off | locked | unlocking | unlocked | failed
  message: '',
  list: [],
  selected: null,
  detail: null,
  revealed: new Map(), // `${id}|${path}` → value, cleared on lock/selection change
  search: '',
  filter: 'all', // all | only_me | agents
  fails: 0,
  backoffUntil: 0,
  editor: null, // { id|null, item }
  conflict: null,
  audit: null,
  stepUp: null, // { sentTo } once a code was emailed
  copiedAt: 0,
};
let idleTimer = null;
let hiddenAt = 0;
let pollTimer = null;
let clipboardTimer = null;

const view = () => ui.ctx.view;
const route = () => {
  const q = parseHash();
  return { vcat: q.get('vcat') || 'all', vv: q.get('vv') || 'list' };
};
const paused = () => !!client.status()?.syncPaused;
const routeKey = () => { const r = route(); return `${r.vcat}|${r.vv}|${ui.editor ? ui.editor.id || 'new' : ''}`; };

// ── Lock / wipe ─────────────────────────────────────────────────────────
async function lock(message = '', { refetch = true } = {}) {
  clearTimeout(idleTimer);
  clearInterval(pollTimer);
  pollTimer = null;
  if (ui.copiedAt && Date.now() - ui.copiedAt < CLIPBOARD_MS) navigator.clipboard?.writeText('').catch(() => {});
  ui.copiedAt = 0;
  await client.lock();
  Object.assign(ui, { list: [], selected: null, detail: null, editor: null, conflict: null, audit: null, stepUp: null, search: '' });
  ui.revealed.clear();
  document.querySelectorAll('#view input, #view textarea').forEach((el) => { el.value = ''; });
  view().replaceChildren();
  shell.setSubnav('passwords', null);
  ui.message = message;
  if (refetch) await open();
}

function armIdle() {
  clearTimeout(idleTimer);
  if (ui.phase === 'unlocked') idleTimer = setTimeout(() => lock('Locked after 15 minutes without activity.'), IDLE_MS);
}

function wireLifecycle() {
  ['pointerdown', 'keydown', 'wheel'].forEach((type) => document.addEventListener(type, armIdle, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (ui.phase === 'unlocked' && hiddenAt && Date.now() - hiddenAt > HIDDEN_MS) lock('Locked while this tab was in the background.');
  });
  // Leaving the page always wipes; a back/forward restore never shows decrypted state.
  window.addEventListener('pagehide', () => { client.lock(); view().replaceChildren(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
  window.addEventListener('hashchange', () => {
    if (ui.phase !== 'unlocked') return;
    if (route().vv !== 'editor') ui.editor = null;
    if (routeKey() !== ui.renderedKey) render(); // our own hash writes already rendered; don't wipe typed input
  });
}

async function pollStatus() {
  if (ui.phase !== 'unlocked') return;
  const before = client.status();
  let next;
  try {
    next = await client.refreshStatus();
  } catch (error) {
    if (error.status === 401) { await client.lock(); window.VaultOrigin.toDashboard(); }
    return;
  }
  if (!next.enabled) return lock('The vault was deleted from this server.');
  if (next.vaultId !== before?.vaultId || next.bundleGeneration !== before?.bundleGeneration || next.epoch !== before?.epoch) {
    return lock('Your master password or vault keys changed on Sulla Desktop. Unlock again with the current password.');
  }
  if (next.headSeq > (before?.headSeq ?? 0)) {
    try {
      const merged = await client.pullDeltas();
      if (merged) { ui.list = merged.list; render(); }
    } catch (error) {
      failIntegrity(error);
    }
  }
}

function failIntegrity(error) {
  const integrity = ['state_mismatch', 'rollback', 'record_mac', 'head_mac', 'bundle_mac', 'record_moved', 'head_moved', 'duplicate_record'];
  if (!integrity.includes(error?.code)) { shell.toast(error?.message || 'That did not work.'); return; }
  lock('', { refetch: false }).then(() => {
    ui.phase = 'failed';
    ui.message = 'The vault failed an integrity check, so nothing was shown. Ask your server administrator to check the vault service.';
    render();
  });
}

// ── Open / unlock ───────────────────────────────────────────────────────
async function open() {
  ui.phase = 'loading';
  render();
  try {
    const status = await client.refreshStatus();
    if (!status.enabled) { ui.phase = 'off'; render(); return; }
    await client.prefetch();
    ui.phase = 'locked';
  } catch (error) {
    if (error.status === 401) { window.VaultOrigin.toDashboard(); return; }
    if (error.code === 'sync_off' || error.status === 404) { ui.phase = 'off'; render(); return; }
    if (error.code === 'unsupported_version') { ui.phase = 'failed'; ui.message = error.message; render(); return; }
    ui.phase = 'failed';
    ui.message = error.message ? `The vault could not load: ${error.message}` : 'The vault could not load.';
  }
  render();
}

async function unlock(form) {
  const input = form.querySelector('input[type=password]');
  const err = form.querySelector('.error');
  if (Date.now() < ui.backoffUntil) {
    err.textContent = `Too many tries. Wait ${Math.ceil((ui.backoffUntil - Date.now()) / 1000)} seconds.`;
    return;
  }
  const password = input.value;
  input.value = ''; // the password goes to the worker; nothing keeps it here
  if (!password) { err.textContent = 'Enter your master password.'; return; }
  ui.phase = 'unlocking';
  form.querySelector('button[type=submit]').disabled = true;
  form.querySelector('button[type=submit]').textContent = 'Unlocking…';
  try {
    const result = await client.unlock(password);
    ui.fails = 0;
    ui.list = result.list;
    ui.phase = 'unlocked';
    ui.message = result.unreadable ? `${result.unreadable} item${result.unreadable === 1 ? '' : 's'} couldn't be read in this browser and ${result.unreadable === 1 ? 'is' : 'are'} hidden.` : '';
    armIdle();
    clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, STATUS_POLL_MS);
    render();
  } catch (error) {
    ui.phase = 'locked';
    if (error.code === 'wrong_password') {
      ui.fails += 1;
      if (ui.fails >= MAX_FAILS) { ui.backoffUntil = Date.now() + BACKOFF_MS; ui.fails = 0; }
      render();
      const e = view().querySelector('.unlock-card .error');
      if (e) e.textContent = 'Wrong master password.';
      return;
    }
    failIntegrity(error);
    if (ui.phase === 'locked') render();
  }
}

// ── Rendering ───────────────────────────────────────────────────────────
function syncNote(icon = VP.server) {
  const s = client.status() || {};
  const from = s.sourceDeviceName ? esc(s.sourceDeviceName) : 'Sulla Desktop';
  return `<p class="vc-cloudnote">${vism(icon)}<span>The organization vault on <b>${from}</b>. End-to-end encrypted: the server stores only ciphertext.${s.lastPushAt ? ` Last upload ${esc(fmtTime(s.lastPushAt))}.` : ''}</span></p>`;
}

function renderOff() {
  const files = route().vv === 'files';
  return `<div class="vc"><section class="unlock-wrap"><div class="unlock-card card"><p class="eyebrow">Sulla Server ${files ? '· Files backup' : 'vault'} · ${esc(ui.ctx.org?.name || '')}</p><h1 class="title">Vault sync is off</h1>
    <p class="lead">${files ? 'Turn on encrypted Files backup in Sulla Desktop › Profile. Your files stay on your computer until you do.' : 'Turn it on in Sulla Desktop › Profile. Your passwords stay on your computer until you do.'}</p>
    ${ui.message ? `<div class="notice">${esc(ui.message)}</div>` : ''}
    <ol class="vc-steps"><li>Open Sulla Desktop</li><li>Go to <b>Profile</b></li><li>Turn on <b>${files ? 'Files backup' : 'Password vault'}</b> under Sulla Server</li></ol>
    <p class="vc-cloudnote">${vism(VP.shield)}<span>When it's on, the vault is encrypted on your computer before upload. You unlock it here with the same master password.</span></p></div></section></div>`;
}

function renderLocked() {
  const s = client.status() || {};
  const files = route().vv === 'files';
  const wait = Date.now() < ui.backoffUntil;
  return `<div class="vc"><section class="unlock-wrap"><div class="unlock-card card"><p class="eyebrow">Sulla Server ${files ? '· Files backup' : 'vault'} · ${esc(ui.ctx.org?.name || '')}</p><h1 class="title">${files ? 'Unlock your encrypted Files backup' : 'Unlock your vault'}</h1>
    <p class="lead">${files ? 'Use your vault master password to open the encrypted Files backup. The password stays inside this browser tab.' : 'Your password stays inside this browser tab. Sulla Server and agents never receive it.'}</p>
    ${ui.message ? `<div class="notice">${esc(ui.message)}</div>` : ''}
    ${s.syncPaused ? '<div class="notice">Sync is paused on Sulla Desktop. You can view items here, but edits are off until it is turned back on.</div>' : ''}
    <form data-unlock autocomplete="off"><label>Password<input type="password" name="password" autocomplete="off" spellcheck="false" ${wait ? 'disabled' : ''} required></label>
      <div class="error" role="alert">${wait ? 'Too many tries. Wait 30 seconds.' : ''}</div>
      <button class="btn primary" type="submit" ${wait ? 'disabled' : ''}>Continue</button></form>
    <p class="security-note">Forgot it? Sulla Server can't recover a master password. Use your recovery code in Sulla Desktop.</p>
    ${syncNote()}</div></section></div>`;
}

function renderFailed() {
  return `<div class="vc"><section class="unlock-wrap"><div class="unlock-card card"><p class="eyebrow">Sulla Server vault</p><h1 class="title">The vault can't open here</h1>
    <p class="lead">${esc(ui.message || 'Something went wrong.')}</p><button class="btn primary" type="button" data-act="retry">Try again</button></div></section></div>`;
}

function filtered() {
  const { vcat } = route();
  const q = ui.search.trim().toLowerCase();
  return ui.list
    .filter((x) => vcat === 'all' || (vcat === 'fav' ? x.favorite : vcat.startsWith('folder:') ? x.folder === vcat.slice(7) : x.type === vcat))
    .filter((x) => ui.filter === 'all' || (ui.filter === 'agents' ? x.agentMode === 'agents' : x.agentMode !== 'agents'))
    .filter((x) => !q || [x.name, x.username, x.host].some((v) => String(v).toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function catLabel() {
  const { vcat } = route();
  if (vcat === 'all') return 'Your passwords';
  if (vcat === 'fav') return 'Favorites';
  if (vcat.startsWith('folder:')) return vcat.slice(7);
  return TYPES.find((t) => t[0] === vcat)?.[1] || 'Your passwords';
}

function renderTop() {
  return `<div class="top"><div class="crumbs"><b>Password vault</b><span class="vc-sync" title="End-to-end encrypted on this server">${vism(VP.server)}On this server · end-to-end encrypted</span></div>
    <label class="search"><span class="si" aria-hidden="true">${vi(VP.search)}</span><input type="search" placeholder="Search vault" data-search value="${esc(ui.search)}" autocomplete="off"></label>
    <div class="acts"><button class="btn pri" type="button" data-act="new" ${paused() ? 'disabled title="Sync is paused on Sulla Desktop"' : ''}><span class="bi">${vi(VP.plus)}</span> New item</button><button class="btn" type="button" title="Lock vault" data-act="lock"><span class="bi">${vi(VP.lock)}</span> Lock</button></div></div>`;
}

function policyBadge(x) {
  const ag = x.agentMode === 'agents';
  const lvl = !ag ? '' : x.agentLevel === 'full' ? 'l3' : x.agentLevel === 'autofill' ? 'l2' : 'l1';
  return `<span class="policy-summary"><span class="lvl ${lvl}"><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>${ag ? esc(x.agentLevel.toUpperCase()) : 'NONE'}</span><span class="who ${ag ? 'agents' : 'personal'}">${ag ? vism(VP.agent) : vism(VP.lock)}${ag ? 'Agents can use' : 'Only me'}</span></span>`;
}

function renderList() {
  const items = filtered();
  if (!items.some((x) => x.id === ui.selected)) { ui.selected = items[0]?.id || null; ui.detail = null; }
  const ag = items.filter((x) => x.agentMode === 'agents').length;
  const rows = items.map((x) => `<button type="button" class="item-row${x.id === ui.selected ? ' selected' : ''}" data-item="${esc(x.id)}"><span class="tile${tint(x.name)}">${esc(initials(x.name))}</span><span class="meta"><span class="name">${esc(x.name)}</span><span class="sub">${esc([x.username, x.host, typeLabel(x.type)].filter(Boolean).join(' · '))}</span></span>${policyBadge(x)}</button>`).join('');
  const seg = (k, label, icon, n) => `<button type="button" data-filter="${k}" class="${ui.filter === k ? 'on' : ''}">${icon ? vism(icon) : ''}${label} <b>${n}</b></button>`;
  const total = ui.list.length;
  return `<section class="content vault-body"><div class="toolbar"><h1>${esc(catLabel())}</h1><span class="meta">Sulla's agents can only use the ones you switch on.</span><div class="right"><span class="meta">Sort: Name</span></div></div>
    ${ui.message ? `<div class="notice">${esc(ui.message)}</div>` : ''}
    ${paused() ? '<div class="notice">Sync is paused on Sulla Desktop. This copy is read-only until it is turned back on.</div>' : ''}
    <div class="filters"><div class="seg">${seg('all', 'All', null, items.length)}${seg('only_me', 'Only me', VP.lock, items.length - ag)}${seg('agents', 'Agents can use', VP.agent, ag)}</div></div>
    <div class="panes"><section class="card listcol"><div class="list-head" aria-hidden="true"><span>Name</span><span>Agent access</span></div><div class="item-list">${rows || `<div class="empty-state"><b>${total ? 'No items match this view' : 'Your vault is empty'}</b><span>${total ? 'Try another category or search.' : 'Items you add here or on Sulla Desktop show up in both places.'}</span></div>`}</div></section>
    <aside class="card detail" data-detail>${ui.selected ? '<div class="honest-state">Opening…</div>' : '<div class="empty-state"><b>Nothing selected</b><span>Pick an item to see its details.</span></div>'}</aside></div></section>`;
}

function field(id, label, value, { secret = false, path = '', copy = false, extra = '' } = {}) {
  const key = `${id}|${path}`;
  const shown = secret ? (ui.revealed.has(key) ? esc(ui.revealed.get(key)) : '••••••••••••') : (value ? esc(value) : '—');
  const btns = secret
    ? `<span class="vc-field-acts"><button type="button" title="${ui.revealed.has(key) ? 'Hide' : 'Reveal'}" aria-label="Reveal ${esc(label)}" data-reveal="${esc(path)}">${vism(VP.eye)}</button><button type="button" title="Copy" aria-label="Copy ${esc(label)}" data-copy="${esc(path)}">${vism(VP.copy)}</button></span>`
    : copy && value ? `<button type="button" title="Copy" aria-label="Copy ${esc(label)}" data-copy-plain="${esc(value)}">${vism(VP.copy)}</button>` : '';
  return `<div class="detail-field${extra}"><span class="k">${esc(label)}</span><span class="v">${shown}</span>${btns}</div>`;
}

function renderDetail(d) {
  const p = d.agentPolicy;
  const ag = p.mode === 'agents';
  let f = '';
  if (d.username) f += field(d.id, 'Username', d.username, { copy: true });
  if (d.hasPassword) f += field(d.id, d.type === 'apiKey' ? 'Secret' : 'Password', '', { secret: true, path: 'password' });
  for (const uri of d.uris) f += field(d.id, 'Website', uri, { copy: true });
  if (d.hasTotp) f += field(d.id, 'One-time code', '', { secret: true, path: 'totp' });
  if (d.card) {
    if (d.card.holder) f += field(d.id, 'Cardholder', d.card.holder);
    if (d.card.hasNumber) f += field(d.id, 'Card number', '', { secret: true, path: 'card.number' });
    if (d.card.expMonth || d.card.expYear) f += field(d.id, 'Expires', [d.card.expMonth, d.card.expYear].filter(Boolean).join('/'));
    if (d.card.hasCode) f += field(d.id, 'Security code', '', { secret: true, path: 'card.code' });
  }
  for (const [k, v] of Object.entries(d.identity || {})) if (v) f += field(d.id, k, String(v));
  for (const c of d.customFields) {
    if (c.type === 'boolean') f += `<div class="detail-field custom-field-detail"><span class="k">${esc(c.label)}</span><span class="v bool-value ${c.value === 'true' ? 'yes' : 'no'}">${c.value === 'true' ? 'Yes' : 'No'}</span></div>`;
    else if (c.secret) f += c.hasValue ? field(d.id, c.label, '', { secret: true, path: `custom:${c.index}`, extra: ' custom-field-detail' }) : '';
    else f += field(d.id, c.label, c.value, { copy: true, extra: ' custom-field-detail' });
  }
  for (const lf of d.legacyFields) f += lf.hidden ? field(d.id, lf.name, '', { secret: true, path: `field:${lf.index}` }) : field(d.id, lf.name, lf.value);
  if (d.notes) f += `<div class="detail-field"><span class="k">Notes</span><span class="v multiline">${esc(d.notes)}</span></div>`;
  const ladderOn = ag ? { metadata: 1, autofill: 2, full: 3 }[p.level] : 0;
  const ro = paused();
  return `<div id="detail-content"><div class="dhead"><span class="tile xl${tint(d.name)}">${esc(initials(d.name))}</span><div class="grow"><h2 id="detail-name">${esc(d.name)}</h2><div class="small muted">${esc(typeLabel(d.type))}${d.folder ? ` · ${esc(d.folder)}` : ''}</div></div>
      <button class="btn sm" type="button" data-act="edit" ${ro ? 'disabled' : ''}>Edit</button><button class="btn sm" type="button" data-act="delete" title="Delete item" aria-label="Delete item" ${ro ? 'disabled' : ''}>${vism(VP.trash)}</button></div>
    <div class="field-stack">${f || '<div class="honest-state">This item has no fields yet.</div>'}</div>
    <div class="access-card"><div class="access-top"><span class="avatar agent">${vi(VP.agent2)}</span><div class="grow"><b>${ag ? 'Agents can use this' : 'Only you can use this'}</b><span>${ag ? (p.level === 'autofill' ? 'Sulla can use it without revealing the secret.' : `Agents have ${esc(p.level)} access.`) : 'Agents cannot use this item.'}</span></div></div>
      <div class="ladder">${['None', 'Metadata', 'Autofill', 'Full'].map((l, i) => `<span class="${i === ladderOn ? 'on' : ''}">${l}</span>`).join('')}</div>
      <div class="kv"><span>Only on</span><b>${p.sites.length ? esc(p.sites.join(', ')) : 'Any registered destination'}</b></div><div class="kv"><span>Expires</span><b>${p.expiresAt ? esc(fmtTime(p.expiresAt)) : 'Never'}</b></div><div class="kv"><span>Ask first</span><b>${p.askFirst ? 'Every use' : 'No'}</b></div></div>
    <section class="activity"><div class="section-line"><b>Recent activity</b></div><div class="honest-state">Item activity (reveals, agent use) is recorded on this server in the audit log.</div></section></div>`;
}

async function loadDetail() {
  const box = view().querySelector('[data-detail]');
  if (!box || !ui.selected) return;
  try {
    ui.detail = await client.detail(ui.selected);
    box.innerHTML = renderDetail(ui.detail);
  } catch (error) {
    box.innerHTML = `<div class="honest-state">${esc(error.message || 'This item could not be opened.')}</div>`;
  }
}

function cfRow(c, i) {
  const opts = CF_TYPES.map(([k, n]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${n}</option>`).join('');
  const value = c.type === 'boolean'
    ? `<label class="cf-toggle"><input type="checkbox" class="cf-input" data-cf-value="${i}" ${String(c.value) === 'true' ? 'checked' : ''}><i aria-hidden="true"></i><span class="cf-toggle-text">${String(c.value) === 'true' ? 'Yes' : 'No'}</span></label>`
    : `<input class="cf-input" data-cf-value="${i}" type="${['password', 'one-time'].includes(c.type) ? 'password' : 'text'}" value="${esc(c.value ?? '')}" autocomplete="off">`;
  return `<div class="custom-field-row" data-type="${esc(c.type)}"><div class="cf-head"><input class="cf-label" data-cf-label="${i}" placeholder="Label" value="${esc(c.label || '')}" aria-label="Custom field label"><select class="cf-type" data-cf-type="${i}" aria-label="Value type">${opts}</select><button type="button" class="cf-icon cf-remove" title="Remove custom field" data-cf-remove="${i}">${vism(VP.x)}</button></div><div class="cf-value">${value}</div></div>`;
}

function renderEditor() {
  const e = ui.editor;
  const it = e.item;
  const p = { ...DEFAULT_POLICY, ...it.agentPolicy };
  const ag = p.mode === 'agents';
  const typeOpts = TYPES.map(([k, , , label]) => `<option value="${k}" ${k === it.type ? 'selected' : ''}>${label}</option>`).join('');
  return `<section class="editor-view"><div class="crumbs"><button class="link-button" type="button" data-act="cancel-edit">Vault</button><span>${vi(VP.chev)}</span><span>${e.id ? 'Edit item' : 'New item'}</span></div>
    <div class="editor-head"><span class="tile xl">${vi(e.id ? VP.note : VP.plus)}</span><div><h1>${e.id ? esc(it.name || 'Edit item') : 'New vault item'}</h1><p>Encrypted in this browser before it's saved. Sulla Desktop picks it up on its next sync.</p></div><span class="grow"></span><button type="button" class="btn" data-act="cancel-edit">Cancel</button><button class="btn primary" type="submit" form="vault-editor">${vi(VP.check)}Save item</button></div>
    <form class="editor-grid" id="vault-editor" data-editor autocomplete="off"><section class="card edit-form"><p class="label">Item details</p><div class="form-grid">
      <label>Type<select name="type">${typeOpts}</select></label>
      <label>Name<input name="name" value="${esc(it.name || '')}" required maxlength="500"></label>
      <label>Username / account<input name="username" value="${esc(it.username || '')}"></label>
      <label>Password / secret<input name="password" type="password" value="${esc(it.password || '')}" autocomplete="new-password"></label>
      <label>Website / API origin<input name="uri" type="url" value="${esc(it.uris?.[0]?.uri || '')}" placeholder="https://example.com"></label>
      <label>Folder<input name="folder" value="${esc(it.folder || '')}"></label>
      <label class="check-label"><input type="checkbox" name="favorite" ${it.favorite ? 'checked' : ''}> Favorite</label>
      <label class="wide">Notes<textarea name="notes">${esc(it.notes || '')}</textarea></label></div>
      <div class="custom-fields"><div class="property-heading"><strong>Custom fields</strong><span class="small muted">${(it.customFields || []).length} of 40</span></div><div>${(it.customFields || []).map(cfRow).join('')}</div><button type="button" class="link-button add-custom-field" data-act="add-cf" ${(it.customFields || []).length >= 40 ? 'disabled' : ''}>${vism(VP.plus)} Add custom field</button></div>
      <div class="error" role="alert" data-editor-error></div></section>
    <section class="card policy-form"><div class="policy-heading"><span class="avatar agent" aria-hidden="true">${vi(VP.agent)}</span><div><p class="label">Who can use this</p><h2>Only you, or your agents too?</h2></div></div>
      <div class="policy-choices"><label class="policy-choice"><input type="radio" name="mode" value="only_me" ${ag ? '' : 'checked'}><span class="choice-icon" aria-hidden="true">${vi(VP.lock)}</span><span><b>Only me</b><small>Locked with your master password. Agents can't see or use it. The server only stores scrambled data.</small></span></label>
        <label class="policy-choice"><input type="radio" name="mode" value="agents" ${ag ? 'checked' : ''}><span class="choice-icon agent" aria-hidden="true">${vi(VP.agent)}</span><span><b>Agents can use</b><small>Your agents can use it for you, within the limits below. You still own it.</small></span></label></div>
      <div class="policy-rules"><p class="label">How much can agents do?</p><div class="access-levels">${LEVELS.map(([k, n, d]) => `<button type="button" data-level="${k}" class="${p.level === k ? 'on' : ''}"><span class="level-radio" aria-hidden="true"></span><span><b>${n}</b><small>${d}</small></span></button>`).join('')}</div></div>
      <div class="policy-detail-grid"><label>Only on<input name="sites" value="${esc(p.sites.join(', '))}" placeholder="example.com, api.example.com"></label><label>Expires<input name="expiresAt" type="datetime-local" value="${p.expiresAt ? esc(new Date(p.expiresAt).toISOString().slice(0, 16)) : ''}"><span class="field-help">Leave blank for no expiry.</span></label><label class="ask-first-row"><span>Ask me first</span><span class="inline-switch"><input type="checkbox" name="askFirst" ${p.askFirst ? 'checked' : ''}><i></i></span><small>Notify me on each use</small></label></div>
      <div class="policy-server"><span class="avatar agent" aria-hidden="true">${vism(VP.server)}</span><span><b>Also allow my agents on the server</b><small>The server's agent key can unlock this item to fill it in. Server admins still can't open it.</small></span><label class="toggle"><input type="checkbox" name="allowServerAgents" ${p.allowServerAgents ? 'checked' : ''}><span></span></label></div>
      <div class="policy-note">Giving agents more access from this browser takes effect only after you confirm it in Sulla Desktop.</div></section></form></section>`;
}

function readEditor(form) {
  const base = structuredClone(ui.editor.item);
  const v = (n) => form.elements[n]?.value ?? '';
  const item = { ...base, type: v('type'), name: v('name').trim(), username: v('username') || undefined, password: v('password') || undefined, folder: v('folder').trim() || undefined, notes: v('notes') || undefined, favorite: form.elements.favorite.checked || undefined };
  item.uris = v('uri') ? [{ ...(base.uris?.[0] || {}), uri: v('uri').trim() }, ...(base.uris || []).slice(1)] : (base.uris || []).slice(1);
  if (!item.uris.length) delete item.uris;
  const cfs = (base.customFields || []).map((c, i) => {
    const valueEl = form.querySelector(`[data-cf-value="${i}"]`);
    return { ...c, label: form.querySelector(`[data-cf-label="${i}"]`)?.value.trim() || '', type: form.querySelector(`[data-cf-type="${i}"]`)?.value || c.type, value: valueEl?.type === 'checkbox' ? String(valueEl.checked) : valueEl?.value ?? '' };
  }).filter((c) => c.label);
  if (cfs.length) item.customFields = cfs;
  else delete item.customFields;
  const level = form.querySelector('[data-level].on')?.dataset.level || 'metadata';
  const expires = v('expiresAt');
  item.agentPolicy = {
    ...DEFAULT_POLICY, ...base.agentPolicy,
    mode: form.querySelector('input[name=mode]:checked')?.value === 'agents' ? 'agents' : 'only_me',
    level, sites: v('sites').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    expiresAt: expires ? new Date(expires).toISOString() : null,
    askFirst: form.elements.askFirst.checked, allowServerAgents: form.elements.allowServerAgents.checked,
  };
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
  return item;
}

function renderConflict() {
  const c = ui.conflict;
  const summary = (it) => it ? `<div class="kv"><span>Name</span><b>${esc(it.name)}</b></div><div class="kv"><span>Username</span><b>${esc(it.username || '—')}</b></div><div class="kv"><span>Website</span><b>${esc(it.uris?.[0]?.uri || '—')}</b></div><div class="kv"><span>Password</span><b>${it.password ? 'Set (hidden)' : '—'}</b></div><div class="kv"><span>Notes</span><b>${it.notes ? `${esc(it.notes.slice(0, 60))}${it.notes.length > 60 ? '…' : ''}` : '—'}</b></div>` : '<div class="honest-state">Deleted on another device.</div>';
  return `<div class="vc-scrim"><div class="utility-dialog" role="dialog" aria-modal="true" aria-label="This item changed somewhere else"><div class="dialog-head"><h2>This item changed somewhere else</h2></div>
    <section><p class="muted">Someone saved a different version of <b>${esc(c.mine?.name || 'this item')}</b> before your change reached Sulla Server. Nothing was overwritten. Pick what to keep.</p>
    <div class="cards"><article><h3>Your version</h3>${summary(c.mine)}</article><article><h3>Their version</h3>${summary(c.theirs)}</article></div>
    <div class="row vc-dialog-acts"><button class="btn" type="button" data-conflict="theirs">Keep theirs</button><button class="btn" type="button" data-conflict="both">Keep both</button><button class="btn primary" type="button" data-conflict="mine">Keep mine</button></div></section></div></div>`;
}

function renderAudit() {
  const a = ui.audit;
  if (!a) return '<section class="content audit-view"><div class="honest-state">Loading the audit log…</div></section>';
  if (a.error) return `<section class="content audit-view"><div class="honest-state">${esc(a.error)}</div></section>`;
  const ev = a.events;
  const sel = ev.find((e) => e.id === a.selected) || ev[0];
  const who = (e) => e.actor === 'browser' ? 'You · browser' : e.actor.startsWith('desktop:') ? 'Sulla Desktop' : e.actor;
  const detailLine = (e) => Object.entries(e.detail || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : v}`).join(' · ');
  return `<section class="content audit-view"><div class="audit-heading"><div><p class="eyebrow">${esc(ui.ctx.org?.name || '')} vault</p><h1>Audit log</h1><p class="lead">Sync activity for this vault: uploads, downloads, saves, sign-ins and rejected requests. Metadata only; no item names or secret values.</p></div><button class="btn" type="button" data-nav="list">Back to vault</button></div>
    <div class="audit-stats"><div class="card stat"><b>${ev.length}</b><span>events on this page</span></div><div class="card stat"><b>${ev.filter((e) => e.actor.startsWith('desktop:')).length}</b><span>from Sulla Desktop</span></div><div class="card stat"><b>${ev.filter((e) => BLOCKED.has(e.event)).length}</b><span>rejected or conflicted</span></div><div class="card stat"><b>Metadata only</b><span>no secret fields returned</span></div></div>
    <div class="audit-layout"><section class="card audit-table">${ev.length ? `<table><thead><tr><th>Time</th><th>Who</th><th>Did what</th><th>Details</th><th>Result</th></tr></thead><tbody>
      ${ev.map((e) => `<tr class="${e === sel ? 'selected' : ''}" data-audit="${esc(e.id)}"><td>${esc(fmtTime(e.at))}</td><td><span class="actor-cell"><span class="avatar ${e.actor === 'browser' ? '' : 'agent'}">${e.actor === 'browser' ? vism(VP.globe) : vism(VP.server)}</span>${esc(who(e))}</span></td><td>${esc(AUDIT_LABELS[e.event] || e.event)}</td><td>${esc(detailLine(e))}</td><td><span class="audit-result ${BLOCKED.has(e.event) ? 'blocked' : ''}">${BLOCKED.has(e.event) ? 'Rejected' : 'Recorded'}</span></td></tr>`).join('')}
    </tbody></table>` : '<div class="honest-state">No sync activity recorded yet.</div>'}<div class="audit-pager"><span class="small muted">Newest first${a.nextBefore ? '' : ' · end of log'}</span>${a.nextBefore ? '<button class="btn sm" type="button" data-act="audit-more">Older</button>' : ''}</div></section>
    <aside class="card audit-detail">${sel ? `<span class="audit-result ${BLOCKED.has(sel.event) ? 'blocked' : ''}">${BLOCKED.has(sel.event) ? 'Rejected' : 'Recorded'}</span><h2>${esc(AUDIT_LABELS[sel.event] || sel.event)}</h2><div class="kv"><span>Who</span><b>${esc(who(sel))}</b></div><div class="kv"><span>When</span><b>${esc(fmtTime(sel.at))}</b></div><div class="kv"><span>Details</span><b>${esc(detailLine(sel) || '—')}</b></div>` : ''}<p class="security-note">Item reveals and agent use are recorded in Sulla Desktop's own audit log, which stays on your computer.</p></aside></div></section>`;
}

function renderSettings() {
  const s = client.status() || {};
  const session = ui.ctx.profile?.vaultSession || {};
  const step = ui.stepUp;
  const del = step?.verified
    ? '<p class="muted">Confirmed. Deleting removes the encrypted vault from Sulla Server for every browser.</p><button class="btn primary" type="button" data-act="delete-copy">Delete vault</button>'
    : step?.sentTo
      ? `<form data-stepup autocomplete="off"><label>Code sent to ${esc(step.sentTo)}<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label><div class="error" role="alert"></div><button class="btn primary" type="submit">Confirm</button></form>`
      : '<p class="muted">Removes the encrypted vault from Sulla Server for everyone. Confirm with a code we email you.</p><button class="btn" type="button" data-act="stepup">Email me a code</button>';
  return `<div class="vc-scrim" data-act="close-settings"><div class="utility-dialog" role="dialog" aria-modal="true" aria-label="Vault settings"><div class="dialog-head"><h2>Vault settings</h2><button class="icon-btn" type="button" data-act="close-settings" aria-label="Close">${vi(VP.x)}</button></div>
    <section><div class="cards"><article><h3>Server vault</h3>
      <div class="kv"><span>Stored on</span><b>${esc(s.sourceDeviceName || 'Sulla Desktop')}</b></div>
      <div class="kv"><span>Last change</span><b>${esc(fmtTime(s.lastPushAt))}</b></div>
      <div class="kv"><span>Items</span><b>${Number(s.recordCount ?? 0)}</b></div>
      <div class="kv"><span>Encrypted size</span><b>${esc(fmtBytes(Number(s.bytes)))}</b></div>
      <div class="kv"><span>Sync</span><b>${s.syncPaused ? 'Paused on Sulla Desktop' : 'On'}</b></div></article>
    <article><h3>This browser</h3><div class="kv"><span>Session ends</span><b>${esc(fmtTime(session.expiresAt))}</b></div><p class="muted">Locks after 15 minutes without activity, when the tab is hidden for 5 minutes, or when you leave the page.</p><button class="btn" type="button" data-act="lock">Lock now</button></article></div></section>
    <section><div class="cards"><article><h3>Master password</h3><p class="muted">Change it in Sulla Desktop. Open browser tabs lock and ask for the new one.</p></article>
    <article><h3>Delete vault</h3>${del}</article></div></section></div></div>`;
}

function setSubnav() {
  if (ui.phase !== 'unlocked') { shell.setSubnav('passwords', null); return; }
  const { vcat, vv } = route();
  const isList = vv === 'list' || vv === 'editor';
  const it = ui.list;
  const items = (rows) => rows.map(([id, label, href, count, active]) => ({ id, label, icon: 'note', href, count, active }));
  const folders = [...new Set(it.map((x) => x.folder).filter(Boolean))].sort();
  const groups = [
    { title: 'Types', items: items([
      ['all', 'Everything', '#vcat=all', it.length, isList && vcat === 'all'],
      ['fav', 'Favorites', '#vcat=fav', it.filter((x) => x.favorite).length, isList && vcat === 'fav'],
      ...TYPES.map(([k, label]) => [k, label, `#vcat=${k}`, it.filter((x) => x.type === k).length, isList && vcat === k]),
    ]) },
  ];
  if (folders.length) groups.push({ title: 'Folders', items: items(folders.map((f) => [`folder:${f}`, f, `#vcat=${encodeURIComponent(`folder:${f}`)}`, it.filter((x) => x.folder === f).length, isList && vcat === `folder:${f}`])) });
  groups.push({ title: 'Manage', items: items([['audit', 'Audit log', '#vv=audit', undefined, vv === 'audit'], ['settings', 'Vault settings', '#vv=settings', undefined, vv === 'settings'], ['files', 'Files backup', '#vv=files', undefined, vv === 'files']]) });
  // Icons per row match the console: types get their glyphs, folders a folder.
  const glyph = { all: 'grid', fav: 'star', login: 'globe', apiKey: 'key', card: 'card', note: 'note', identity: 'users', audit: 'list', settings: 'shield' };
  for (const g of groups) for (const row of g.items) row.icon = glyph[row.id] || 'folderLine';
  shell.setSubnav('passwords', groups);
}

function render() {
  const el = view();
  if (!el) return;
  shell.setNavCount('passwords', { off: 'off', unlocked: 'open', locked: 'locked', unlocking: 'locked' }[ui.phase] || '', '');
  setSubnav();
  if (ui.phase === 'loading') { ui.ctx.states.loading(el, 'Loading your vault…'); return; }
  if (ui.phase === 'off') { el.innerHTML = renderOff(); return; }
  if (ui.phase === 'failed') { el.innerHTML = renderFailed(); return; }
  if (ui.phase === 'locked' || ui.phase === 'unlocking') {
    el.innerHTML = renderLocked();
    el.querySelector('input[type=password]')?.focus();
    return;
  }
  const { vv } = route();
  if (vv === 'files') { ui.renderedKey = routeKey(); renderFilesBackup({ view: el, client }); return; }
  ui.renderedKey = routeKey();
  const body = vv === 'audit' ? renderAudit() : ui.editor ? renderEditor() : renderList();
  el.innerHTML = `<div class="vc"><div class="vault-shell vc-onecol"><main class="main">${ui.editor ? '' : renderTop()}${body}${vv === 'settings' ? renderSettings() : ''}${ui.conflict ? renderConflict() : ''}</main></div></div>`;
  if (vv === 'audit' && !ui.audit) loadAudit();
  if (!ui.editor && vv !== 'audit') loadDetail();
}

async function loadAudit(before) {
  try {
    const res = await client.audit(before);
    ui.audit = { events: [...(before ? ui.audit?.events || [] : []), ...res.events], nextBefore: res.nextBefore, selected: ui.audit?.selected };
  } catch (error) {
    ui.audit = { error: error.status === 401 ? 'Your session ended.' : 'The audit log could not load.' };
  }
  render();
}

// ── Events ──────────────────────────────────────────────────────────────
async function copyValue(value) {
  try {
    await navigator.clipboard.writeText(value);
    ui.copiedAt = Date.now();
    shell.toast('Copied. The clipboard clears in 30 seconds.');
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(() => {
      if (document.hasFocus() && ui.copiedAt) navigator.clipboard.writeText('').catch(() => {});
      ui.copiedAt = 0;
    }, CLIPBOARD_MS);
  } catch {
    shell.toast('Copy is blocked in this browser.');
  }
}

async function saveEditor(form) {
  const err = form.querySelector('[data-editor-error]');
  let item;
  try {
    item = readEditor(form);
  } catch (error) {
    err.textContent = error.message;
    return;
  }
  if (!item.name) { err.textContent = 'Give the item a name.'; return; }
  const submit = view().querySelector('button[form="vault-editor"]');
  submit.disabled = true;
  try {
    const res = await client.save(item, ui.editor.id);
    if (res.conflict) {
      ui.conflict = res.conflict;
      render();
      return;
    }
    ui.list = res.list;
    ui.selected = res.id;
    ui.editor = null;
    location.hash = 'vv=list';
    shell.toast('Saved and encrypted. Sulla Desktop picks it up on its next sync.');
    render();
  } catch (error) {
    submit.disabled = false;
    if (error.code === 'sync_paused') err.textContent = 'Sync is paused on Sulla Desktop, so edits are off.';
    else if (error.status === 401) { await client.lock(); window.VaultOrigin.toDashboard(); }
    else failIntegrity(error);
    if (!err.textContent && error.message) err.textContent = error.message;
  }
}

async function resolveConflict(choice) {
  const c = ui.conflict;
  ui.conflict = null;
  try {
    if (choice === 'theirs') {
      ui.list = await client.list();
      ui.editor = null;
    } else {
      const item = choice === 'both' ? { ...c.mine, name: `${c.mine.name} (conflict copy)` } : c.mine;
      const res = await client.save(item, choice === 'both' || !c.theirs ? null : c.id);
      if (res.conflict) { ui.conflict = res.conflict; render(); return; }
      ui.list = res.list;
      ui.selected = res.id;
      ui.editor = null;
    }
    location.hash = 'vv=list';
    render();
  } catch (error) {
    failIntegrity(error);
  }
}

function wireEvents() {
  const el = view();
  el.addEventListener('submit', (event) => {
    const form = event.target;
    event.preventDefault();
    if (form.matches('[data-unlock]')) unlock(form);
    else if (form.matches('[data-editor]')) saveEditor(form);
    else if (form.matches('[data-stepup]')) {
      const code = form.elements.code.value;
      client.stepUpVerify(code).then(() => { ui.stepUp = { ...ui.stepUp, verified: true }; render(); })
        .catch((error) => { form.querySelector('.error').textContent = error.body?.error || 'That code did not work.'; });
    }
  });
  el.addEventListener('input', (event) => {
    if (event.target.matches('[data-search]')) {
      ui.search = event.target.value;
      const pos = event.target.selectionStart;
      render();
      const input = view().querySelector('[data-search]');
      input?.focus();
      input?.setSelectionRange(pos, pos);
    }
  });
  el.addEventListener('change', (event) => {
    const t = event.target;
    if (t.matches('[data-cf-type]') && ui.editor) {
      const form = t.closest('form');
      ui.editor.item = { ...readEditor(form), customFields: (ui.editor.item.customFields || []).map((c, i) => (i === Number(t.dataset.cfType) ? { ...c, label: form.querySelector(`[data-cf-label="${i}"]`).value, type: t.value } : c)) };
      render();
    }
  });
  el.addEventListener('click', async (event) => {
    const t = event.target.closest('button, a, [data-item], [data-audit], .vc-scrim');
    if (!t) return;
    const d = t.dataset;
    if (t.classList.contains('vc-scrim') && event.target !== t) return;
    if (d.act === 'retry') return open();
    if (d.act === 'lock') return lock();
    if (d.item) { ui.selected = d.item; ui.revealed.clear(); render(); return; }
    if (d.filter) { ui.filter = d.filter; render(); return; }
    if (d.nav) { location.hash = `vv=${d.nav}`; return; }
    if (d.audit && ui.audit) { ui.audit.selected = d.audit; render(); return; }
    if (d.act === 'audit-more') return loadAudit(ui.audit?.nextBefore);
    if (d.act === 'close-settings') { location.hash = 'vv=list'; ui.stepUp = null; return; }
    if (d.reveal !== undefined && ui.selected) {
      const key = `${ui.selected}|${d.reveal}`;
      if (ui.revealed.has(key)) ui.revealed.delete(key);
      else ui.revealed.set(key, await client.reveal(ui.selected, d.reveal));
      view().querySelector('[data-detail]').innerHTML = renderDetail(ui.detail);
      return;
    }
    if (d.copy !== undefined && ui.selected) return copyValue(await client.reveal(ui.selected, d.copy));
    if (d.copyPlain !== undefined) return copyValue(d.copyPlain);
    if (d.act === 'new') {
      ui.editor = { id: null, item: { type: 'login', name: '', agentPolicy: { ...DEFAULT_POLICY } } };
      location.hash = 'vv=editor';
      render();
      return;
    }
    if (d.act === 'edit' && ui.selected) {
      ui.editor = { id: ui.selected, item: await client.editable(ui.selected) };
      location.hash = 'vv=editor';
      render();
      return;
    }
    if (d.act === 'cancel-edit') { ui.editor = null; location.hash = 'vv=list'; render(); return; }
    if (d.act === 'add-cf' && ui.editor) {
      const form = t.closest('form');
      const item = readEditor(form);
      ui.editor.item = { ...item, customFields: [...(ui.editor.item.customFields || []).map((c, i) => ({ ...c, label: form.querySelector(`[data-cf-label="${i}"]`)?.value ?? c.label, value: form.querySelector(`[data-cf-value="${i}"]`)?.value ?? c.value })), { label: '', type: 'text', value: '' }] };
      render();
      return;
    }
    if (d.cfRemove !== undefined && ui.editor) {
      const form = t.closest('form');
      const item = readEditor(form);
      ui.editor.item = { ...item, customFields: (ui.editor.item.customFields || []).filter((_, i) => i !== Number(d.cfRemove)) };
      render();
      return;
    }
    if (d.level) {
      t.parentElement.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('on', b === t));
      return;
    }
    if (d.act === 'delete' && ui.selected) {
      const name = ui.detail?.name || 'this item';
      if (!window.confirm(`Delete “${name}” from your vault? It's removed here and on Sulla Desktop at its next sync.`)) return;
      try {
        const res = await client.remove(ui.selected);
        ui.list = res.list;
        ui.selected = null;
        shell.toast('Deleted.');
        render();
      } catch (error) {
        failIntegrity(error);
      }
      return;
    }
    if (d.conflict) return resolveConflict(d.conflict);
    if (d.act === 'stepup') {
      try {
        const res = await client.stepUpStart();
        ui.stepUp = { sentTo: res.sentTo };
      } catch (error) {
        shell.toast(error.body?.error || 'We could not send a code.');
      }
      render();
      return;
    }
    if (d.act === 'delete-copy') {
      if (!window.confirm('Delete the encrypted vault from this server?')) return;
      try {
        await client.deleteCloudCopy();
        await lock('The vault was deleted from this server.');
      } catch (error) {
        shell.toast(error.code === 'reauth_required' ? 'Confirm with a new email code first.' : 'The vault could not be deleted.');
        if (error.code === 'reauth_required') { ui.stepUp = null; render(); }
      }
    }
  });
}

shell.screen({
  async mount(ctx) {
    ui.ctx = ctx;
    if (!ui.wired) { wireEvents(); wireLifecycle(); ui.wired = true; }
    await open();
  },
  async reload(ctx) {
    ui.ctx = ctx;
    await lock('', { refetch: true });
  },
});
