/**
 * Tray panel renderer — sidebar switching, state updates, button handlers.
 * Uses nodeIntegration (like audio driver) — no preload needed.
 */

const { ipcRenderer } = require('electron');

// ── Auth state management ──────────────────────────────────────────────
let isLoggedIn = false;

function setAuthUI(loggedIn, vaultSetUp) {
  isLoggedIn = loggedIn;
  const overlay = document.getElementById('login-overlay');
  const layout = document.querySelector('.app-layout');

  if (!vaultSetUp || loggedIn) {
    // Vault not set up (first run) or logged in — show normal UI
    overlay.classList.add('hidden');
    layout.classList.remove('locked');
  } else {
    // Locked — show login form
    overlay.classList.remove('hidden');
    layout.classList.add('locked');
    setTimeout(() => {
      const pwInput = document.getElementById('login-password');
      if (pwInput) pwInput.focus();
    }, 100);
  }
}

// Check auth state on load
ipcRenderer.invoke('tray-panel:check-auth').then((state) => {
  setAuthUI(state.loggedIn, state.vaultSetUp);
}).catch(() => {
  // If check fails, default to showing login
  setAuthUI(false, true);
});

// Listen for auth state changes from main process
ipcRenderer.on('tray-panel:auth-state', (_event, state) => {
  setAuthUI(state.loggedIn, state.vaultSetUp);
  const pwInput = document.getElementById('login-password');
  const errEl = document.getElementById('login-error');
  if (pwInput) pwInput.value = '';
  if (errEl) errEl.textContent = '';
});

// Login form submission
document.getElementById('login-form').addEventListener('submit', async(e) => {
  e.preventDefault();
  const pwInput = document.getElementById('login-password');
  const errEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');
  const password = pwInput.value.trim();

  if (!password) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Unlocking...';
  errEl.textContent = '';

  try {
    const result = await ipcRenderer.invoke('tray-panel:login', { password });
    if (result.success) {
      pwInput.value = '';
    } else {
      errEl.textContent = 'Incorrect password';
      pwInput.select();
    }
  } catch (err) {
    errEl.textContent = 'Login failed';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Unlock';
  }
});

// "Open main window" link on login screen
document.getElementById('login-open-main').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-main');
});

// ── Sidebar navigation ──────────────────────────────────────────────────

const sidebarBtns = document.querySelectorAll('.sidebar-btn[data-panel]');
const panels = document.querySelectorAll('.panel');

function selectPanel(target) {
    sidebarBtns.forEach(b => b.classList.remove('active'));
    document.querySelector(`.sidebar-btn[data-panel="${ target }"]`)?.classList.add('active');

    // Show target panel
    panels.forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`panel-${ target }`);
    if (panel) panel.classList.add('active');
    document.getElementById('app').classList.toggle('files-mode', target === 'files');
    if (target === 'files') refreshFilesDashboard();
    else sendPanelSize();
}

// Size the window to the visible view (the Files view is wider and taller).
function sendPanelSize() {
  window.requestAnimationFrame(() => {
    const app = document.getElementById('app');
    ipcRenderer.send('tray-panel:view-change', app.classList.contains('files-mode') ? 'files' : 'default', { width: Math.ceil(app.offsetWidth) + 40, height: Math.ceil(app.offsetHeight) + 24 });
  });
}

sidebarBtns.forEach(btn => {
  btn.addEventListener('click', () => selectPanel(btn.getAttribute('data-panel')));
});

ipcRenderer.on('tray-panel:select-view', (_event, target) => selectPanel(target));

// ── Audio driver renderer layer ─────────────────────────────────────────
// Sets up window.audioDriver IPC bridge, then loads the full renderer
// controller (mic capture, VAD, device enumeration, meters, gateway streaming).
try {
  require('./renderer/bridge');
  console.log('[panel.js] Bridge loaded');
} catch (e) {
  console.error('[panel.js] Failed to load bridge:', e);
}

try {
  require('./renderer/controller/app');
  console.log('[panel.js] Controller loaded');
} catch (e) {
  console.error('[panel.js] Failed to load controller:', e);
}

// ── Button handlers ─────────────────────────────────────────────────────

document.getElementById('btn-open-sulla').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-main');
});

document.getElementById('btn-open-docker').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-docker');
});

document.getElementById('btn-open-dashboard').addEventListener('click', () => {
  const btn = document.getElementById('btn-open-dashboard');
  if (btn.classList.contains('disabled')) return;
  ipcRenderer.send('tray-panel:open-dashboard');
});

document.getElementById('btn-secretary-mode').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:secretary-mode');
});

document.getElementById('btn-capture-studio').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-capture-studio');
});

let filesPaused = false;
async function openFilesFolder() {
  try { await ipcRenderer.invoke('tray-panel:files-open') } catch (error) { showFilesToast(error.message || 'Could not open the Files folder', true) }
}

document.getElementById('btn-open-files').addEventListener('click', openFilesFolder);
document.getElementById('btn-pause-files').addEventListener('click', async() => {
  try { await ipcRenderer.invoke('tray-panel:files-pause', !filesPaused); await refreshFilesStatus() } catch { /* status refresh shows the error */ }
});

async function refreshFilesStatus() {
  const status = await ipcRenderer.invoke('tray-panel:files-status'); filesPaused = status.state === 'paused';
  const dot = document.getElementById('files-dot'); const label = document.getElementById('files-status');
  dot.className = `dot ${ status.state === 'synced' ? 'running' : status.state === 'syncing' ? 'starting' : status.state === 'paused' ? 'off' : 'error' }`;
  label.textContent = status.state === 'syncing' ? `Syncing ${ status.pendingFiles || '' }`.trim() : status.state[0].toUpperCase() + status.state.slice(1);
  label.title = status.lastError || '';
  document.getElementById('files-action-label').textContent = filesPaused ? 'Resume sync' : 'Pause sync';
}
refreshFilesStatus(); setInterval(() => refreshFilesStatus(), 5_000);

// Settings panel buttons
document.getElementById('btn-support').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-url', 'https://sulladesktop.com/support');
});

document.getElementById('btn-documentation').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-url', 'https://sulladesktop.com/docs');
});

document.getElementById('btn-discussions').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-url', 'https://sulladesktop.com/support');
});

document.getElementById('btn-issues').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-url', 'https://sulladesktop.com/support');
});

document.getElementById('btn-check-updates').addEventListener('click', () => {
  ipcRenderer.invoke('tray-panel:check-updates');
});

document.getElementById('btn-quit').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:quit');
});

// ── Settings toggles ───────────────────────────────────────────────────

const toggleAutoStart = document.getElementById('toggle-auto-start');
const toggleBackground = document.getElementById('toggle-start-background');

// Load current settings on startup
ipcRenderer.invoke('tray-panel:get-settings').then((settings) => {
  toggleAutoStart.checked = settings.autoStart;
  toggleBackground.checked = settings.startInBackground;
}).catch(() => {});

// Listen for settings state updates from main process
ipcRenderer.on('tray-panel:settings-state', (_event, state) => {
  toggleAutoStart.checked = state.autoStart;
  toggleBackground.checked = state.startInBackground;
});

// Send setting changes to main process
toggleAutoStart.addEventListener('change', () => {
  ipcRenderer.send('tray-panel:set-setting', { key: 'autoStart', value: toggleAutoStart.checked });
});

toggleBackground.addEventListener('change', () => {
  ipcRenderer.send('tray-panel:set-setting', { key: 'startInBackground', value: toggleBackground.checked });
});

// ── State updates from main process ─────────────────────────────────────

const STATE_MAP = {
  STOPPED:  { cls: 'off', label: 'Stopped' },
  STARTING: { cls: 'starting', label: 'Starting...' },
  STARTED:  { cls: 'running', label: 'Running' },
  STOPPING: { cls: 'starting', label: 'Stopping...' },
  ERROR:    { cls: 'error', label: 'Error' },
  DISABLED: { cls: 'off', label: 'Disabled' },
};

function updateDot(dotEl, statusEl, state) {
  const mapped = STATE_MAP[state] || STATE_MAP.STOPPED;
  dotEl.className = `dot ${ mapped.cls }`;
  statusEl.textContent = mapped.label;
}

ipcRenderer.on('tray-panel:state-update', (_event, state) => {
  if (state.docker) {
    updateDot(
      document.getElementById('docker-dot'),
      document.getElementById('docker-status'),
      state.docker,
    );
  }

  if (state.k8s) {
    updateDot(
      document.getElementById('k8s-dot'),
      document.getElementById('k8s-status'),
      state.k8s,
    );

    // Enable Cluster Dashboard only when Kubernetes is running
    const dashBtn = document.getElementById('btn-open-dashboard');
    if (state.k8s === 'STARTED') {
      dashBtn.classList.remove('disabled');
    } else {
      dashBtn.classList.add('disabled');
    }
  }

  if (state.k8sContext) {
    document.getElementById('k8s-status').textContent += ` (${ state.k8sContext })`;
  }

});

// ── Sulla Files view ───────────────────────────────────────────
// Markup mirrors mockups/files/04-tray.html; styles live in files.css.
let filesRecording = false;
let filesMic = true;
let filesCam = false;
let filesPausedNow = false;
let filesShotMode = 'area';
let filesUploadMode = 'view';
let filesToastTimer;

const FILES_ICONS = {
  doc:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  play:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  local:    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9" opacity=".16"/><path d="M8 12.5l2.6 2.6L16.5 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  syncing:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5"/><path d="M4 7v5h5M20 17v-5h-5"/></svg>',
  conflict: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  link:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>',
  copy:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/></svg>',
  eye:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  pause:    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  resume:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
};

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);

  return `${ (Number(bytes) / (1024 ** index)).toFixed(index > 1 ? 1 : 0) } ${ units[index] }`;
}

// 402 → "6:42", 3725 → "1:02:05"
function formatDuration(totalSeconds) {
  const seconds = Math.round(Number(totalSeconds)); const pad = value => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3_600); const minutes = Math.floor(seconds % 3_600 / 60);

  return hours ? `${ hours }:${ pad(minutes) }:${ pad(seconds % 60) }` : `${ minutes }:${ pad(seconds % 60) }`;
}

function clockTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// "38 s ago", "12 min ago", "10:12 AM", "Yesterday", "Oct 14"
function relativeTime(value) {
  const date = new Date(value);
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1_000));
  if (seconds < 60) return `${ seconds } s ago`;
  if (seconds < 3_600) return `${ Math.floor(seconds / 60) } min ago`;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return clockTime(date);
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Yesterday';

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeText(value) {
  const node = document.createElement('span'); node.textContent = String(value ?? '');

  return node.innerHTML;
}

function fileFolder(relativePath) {
  const parts = String(relativePath || '').split('/');

  return parts.length > 1 ? parts[0] : 'Files';
}

function fileThumb(name, mime) {
  const ext = String(name).split('.').pop().toLowerCase();
  const type = String(mime || '');
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return '<span class="th"></span>';
  if (type.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return `<span class="th dark"><span class="play">${ FILES_ICONS.play }</span></span>`;
  let kind = 'doc';
  if (type === 'application/pdf' || ext === 'pdf') kind = 'pdf';
  else if (type.startsWith('audio/') || ['mp3', 'wav', 'm4a'].includes(ext)) kind = 'aud';
  else if (['zip', 'gz', 'tar', 'dmg'].includes(ext)) kind = 'zip';
  else if (['js', 'ts', 'json', 'py', 'sh', 'yaml', 'yml', 'go', 'rs'].includes(ext)) kind = 'code';

  return `<span class="fi ${ kind }">${ FILES_ICONS.doc }</span>`;
}

function showFilesToast(message, error = false) {
  const toast = document.getElementById('files-toast');
  toast.innerHTML = `<span class="ok">${ error ? '!' : FILES_ICONS.check }</span><span>${ escapeText(message) }</span>`;
  toast.classList.toggle('err', error); toast.classList.add('on'); clearTimeout(filesToastTimer);
  filesToastTimer = setTimeout(() => toast.classList.remove('on'), 3_500);
}

function renderRecentFiles(files) {
  const list = document.getElementById('files-recent');
  if (!files.length) { list.innerHTML = '<div class="it empty">No recent files yet</div>'; return }
  list.innerHTML = files.slice(0, 4).map((file) => {
    const name = file.path.split('/').pop();
    const encoded = encodeURIComponent(file.path);
    if (file.conflict) {
      return `<div class="it" data-resolve="${ encoded }">${ fileThumb(name, file.mime) }<div class="n"><b>${ escapeText(name) }</b><small>Edited on two desktops · pick a version</small></div><span class="sync conflict">${ FILES_ICONS.conflict }</span><button class="btn sm" data-resolve="${ encoded }">Resolve</button></div>`;
    }
    const state = file.syncState === 'syncing' ? 'syncing' : file.syncState === 'error' ? 'conflict' : 'local';
    const media = /^(image|video)\//.test(String(file.mime)) || /\.(png|jpe?g|gif|webp|heic|mp4|mov|webm|m4v)$/i.test(name);
    const when = relativeTime(file.updatedAt);
    const meta = [fileFolder(file.path), media || when.endsWith('ago') ? when : `edited ${ when }`];
    if (Number(file.durationSeconds) > 0) meta.push(formatDuration(file.durationSeconds));

    return `<div class="it" data-open="${ encoded }">${ fileThumb(name, file.mime) }<div class="n"><b>${ escapeText(name) }</b><small>${ escapeText(meta.join(' · ')) }</small></div><span class="sync ${ state }">${ FILES_ICONS[state] }</span><button class="btn sm" title="Share online · copy link" data-share="${ encoded }" data-id="${ escapeText(file.id) }" data-size="${ Number(file.size) || 0 }">${ FILES_ICONS.link }</button></div>`;
  }).join('');
}

function renderRecentShares(shares, unavailable) {
  const list = document.getElementById('files-shares');
  if (unavailable) { list.innerHTML = '<div class="it empty">Sharing comes online when links ship</div>'; return }
  if (!shares.length) { list.innerHTML = '<div class="it empty">No shared links yet</div>'; return }
  list.innerHTML = shares.slice(0, 3).map((share) => {
    const parts = [String(share.url).replace(/^https?:\/\//, '')];
    parts.push(share.password ? 'password' : share.mode === 'download' ? 'download' : 'view only');
    if (share.expiresAt) parts.push(new Date(share.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' }));

    return `<div class="it" data-copy="${ encodeURIComponent(share.url) }">${ fileThumb(share.name) }<div class="n"><b>${ escapeText(share.name) }</b><small>${ escapeText(parts.join(' · ')) }</small></div><span class="views">${ FILES_ICONS.eye } ${ Number(share.viewCount) || 0 }</span><button class="btn sm" title="Copy link" data-copy="${ encodeURIComponent(share.url) }">${ FILES_ICONS.copy }</button></div>`;
  }).join('');
}

function updateFilesSync(status, files) {
  const state = status.state || 'error';
  filesPausedNow = state === 'paused';
  document.getElementById('files-sync-dot').className = `st ${ ['paused', 'conflict', 'error'].includes(state) ? state : '' }`;
  document.getElementById('files-sync-title').textContent = state === 'synced' ? 'Everything is synced' : state === 'paused' ? 'Sync paused' : state === 'conflict' ? 'Sync needs attention' : state === 'syncing' ? `Syncing ${ status.pendingFiles } file${ status.pendingFiles === 1 ? '' : 's' }` : 'Files are local-only';
  const total = Number(status.totalBytes) || 0; const done = Number(status.processedBytes) || 0;
  const active = files.find(file => file.syncState === 'syncing');
  const seconds = Math.max(1, Math.round(status.estimatedSeconds || 0));
  const eta = seconds < 60 ? `${ seconds } s` : `${ Math.round(seconds / 60) } min`;
  const syncing = [active ? fileFolder(active.path) : '', `${ formatBytes(done) } of ${ formatBytes(total) }`, `about ${ eta } left`].filter(Boolean).join(' · ');
  document.getElementById('files-sync-detail').textContent = state === 'syncing' && total ? syncing : status.lastError || (status.serverLabel ? `Available on ${ status.serverLabel }` : 'Available on this computer');
  document.getElementById('files-progress-bar').style.width = total ? `${ Math.min(100, Math.round(done / total * 100)) }%` : state === 'synced' ? '100%' : '0%';
  const toggle = document.getElementById('files-pause-toggle');
  toggle.title = filesPausedNow ? 'Resume sync' : 'Pause sync'; toggle.innerHTML = filesPausedNow ? FILES_ICONS.resume : FILES_ICONS.pause;
  document.getElementById('files-pause-label').textContent = filesPausedNow ? 'Resume sync' : 'Pause sync';
  document.querySelector('#files-pause-hour .key').style.visibility = filesPausedNow ? 'hidden' : '';
}

function updateCaptureNotes(preferences) {
  const action = preferences.defaultAction || 'share';
  const shot = action === 'save' ? 'Saves to Files' : action === 'ask' ? 'Asks after each capture' : 'Shares online · link copied';
  const record = action === 'save' ? 'Saves to Files · transcribed' : action === 'ask' ? 'Asks after recording' : 'Shares online · transcribed';
  document.querySelector('[data-capture-note="screenshot"]').textContent = shot;
  if (!filesRecording) document.getElementById('files-record-state').textContent = record;
}

async function refreshFilesDashboard() {
  try {
    const dashboard = await ipcRenderer.invoke('tray-panel:files-dashboard');
    const files = dashboard.files || [];
    updateFilesSync(dashboard.status, files); renderRecentFiles(files); renderRecentShares(dashboard.shares || [], dashboard.sharingUnavailable);
    filesMic = dashboard.preferences.recordMic !== false; filesCam = dashboard.preferences.recordCamera === true;
    if (dashboard.preferences.visitorMode === 'download' || dashboard.preferences.visitorMode === 'view') selectUploadMode(dashboard.preferences.visitorMode);
    document.getElementById('files-mic').classList.toggle('on', filesMic); document.getElementById('files-cam').classList.toggle('on', filesCam);
    updateCaptureNotes(dashboard.preferences);
  } catch (error) { showFilesToast(error.message || 'Files are temporarily unavailable', true) }
  sendPanelSize();
}

function selectUploadMode(mode) {
  filesUploadMode = mode;
  document.querySelectorAll('[data-upload-mode]').forEach(chip => chip.classList.toggle('on', chip.dataset.uploadMode === mode));
}

async function takeScreenshot(mode) {
  filesShotMode = mode;
  document.querySelectorAll('[data-shot]').forEach(chip => chip.classList.toggle('on', chip.dataset.shot === mode));
  try { await ipcRenderer.invoke('tray-panel:capture-screenshot', mode) } catch (error) { if (!error.cancelled) showFilesToast(error.message || 'Screenshot failed', true); }
}

document.getElementById('files-cap-shot').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-shot]');
  takeScreenshot(chip ? chip.dataset.shot : filesShotMode);
});
document.getElementById('files-record').addEventListener('click', async(event) => {
  if (event.target.closest('.tg')) return;
  try {
    const result = await ipcRenderer.invoke('tray-panel:capture-record', { mic: filesMic, camera: filesCam }); filesRecording = result.recording;
    document.getElementById('files-record').classList.toggle('rec', filesRecording);
    if (filesRecording) document.getElementById('files-record-state').textContent = 'Recording · click to stop';
    else if (result.error) document.getElementById('files-record-state').textContent = result.error;
    else refreshFilesDashboard();
  } catch (error) { showFilesToast(error.message || 'Recording failed', true) }
});
for (const [id, key] of [['files-mic', 'record-mic'], ['files-cam', 'record-cam']]) {
  document.getElementById(id).addEventListener('click', () => {
    if (id === 'files-mic') filesMic = !filesMic; else filesCam = !filesCam;
    document.getElementById(id).classList.toggle('on', id === 'files-mic' ? filesMic : filesCam);
    ipcRenderer.send('tray-panel:set-capture-toggle', key, id === 'files-mic' ? filesMic : filesCam);
  });
}

async function uploadAndShare() {
  try {
    const capture = await ipcRenderer.invoke('tray-panel:capture-upload'); if (!capture) return;
    const result = await ipcRenderer.invoke('tray-panel:share-capture', capture, { mode: filesUploadMode, keepAvailable: false });
    showFilesToast(result.message, !result.url); refreshFilesDashboard();
  } catch (error) { showFilesToast(error.message || 'Upload failed', true) }
}
document.getElementById('files-upload').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-upload-mode]');
  if (chip) { selectUploadMode(chip.dataset.uploadMode); return }
  uploadAndShare();
});
ipcRenderer.on('tray-panel:shortcut-upload', uploadAndShare);

async function toggleFilesPause() {
  try { await ipcRenderer.invoke('tray-panel:files-pause', !filesPausedNow) } catch (error) { showFilesToast(error.message || 'Could not change sync', true) }
  refreshFilesDashboard();
}
document.getElementById('files-pause-toggle').addEventListener('click', toggleFilesPause);
document.getElementById('files-pause-hour').addEventListener('click', async() => {
  if (filesPausedNow) { toggleFilesPause(); return }
  try { await ipcRenderer.invoke('tray-panel:files-pause-hour'); showFilesToast('Sync paused for 1 hour') } catch (error) { showFilesToast(error.message || 'Could not pause sync', true) }
  refreshFilesDashboard();
});
document.getElementById('files-open-folder').addEventListener('click', openFilesFolder);
document.getElementById('files-open-sulla').addEventListener('click', () => ipcRenderer.send('tray-panel:open-main'));
document.getElementById('files-preferences').addEventListener('click', () => ipcRenderer.send('tray-panel:files-preferences', 'capture'));
document.getElementById('files-all-files').addEventListener('click', () => ipcRenderer.send('tray-panel:open-files-screen'));
document.getElementById('files-all-shares').addEventListener('click', () => ipcRenderer.send('tray-panel:open-files-screen', 'shared-by-me'));
document.getElementById('panel-files').addEventListener('click', async(event) => {
  const target = event.target.closest('[data-share],[data-copy],[data-resolve],[data-open]'); if (!target) return;
  if (target.dataset.share) {
    const relativePath = decodeURIComponent(target.dataset.share);
    try {
      const result = await ipcRenderer.invoke('tray-panel:share-capture', { relativePath, path: relativePath, name: relativePath.split('/').pop(), size: Number(target.dataset.size) || 0, kind: 'upload', fileId: target.dataset.id || undefined }, { mode: filesUploadMode, keepAvailable: false });
      showFilesToast(result.message, !result.url); refreshFilesDashboard();
    } catch (error) { showFilesToast(error.message || 'Sharing failed', true) }
  } else if (target.dataset.copy) {
    try { await ipcRenderer.invoke('tray-panel:copy-share', decodeURIComponent(target.dataset.copy)); showFilesToast('Link copied') } catch (error) { showFilesToast(error.message || 'Could not copy the link', true) }
  } else if (target.dataset.resolve) {
    try { await ipcRenderer.invoke('tray-panel:resolve-file', decodeURIComponent(target.dataset.resolve)) } catch (error) { showFilesToast(error.message || 'Could not reveal the file', true) }
  } else {
    try { await ipcRenderer.invoke('tray-panel:open-file', decodeURIComponent(target.dataset.open)) } catch (error) { showFilesToast(error.message || 'Could not open the file', true) }
  }
});
