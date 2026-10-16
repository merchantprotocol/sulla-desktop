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
    ipcRenderer.send('tray-panel:view-change', target);
    if (target === 'files') void refreshFilesDashboard();
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
document.getElementById('btn-open-files').addEventListener('click', () => ipcRenderer.send('tray-panel:files-open'));
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
void refreshFilesStatus(); setInterval(() => void refreshFilesStatus(), 5_000);

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
let filesRecording = false;
let filesMic = true;
let filesCam = false;
let filesToastTimer;

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);

  return `${ (Number(bytes) / (1024 ** index)).toFixed(index > 1 ? 1 : 0) } ${ units[index] }`;
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${ Math.floor(seconds / 60) }m ago`;
  if (seconds < 86_400) return `${ Math.floor(seconds / 3_600) }h ago`;

  return `${ Math.floor(seconds / 86_400) }d ago`;
}

function escapeText(value) {
  const node = document.createElement('span'); node.textContent = String(value ?? '');

  return node.innerHTML;
}

function showFilesToast(message) {
  const toast = document.getElementById('files-toast');
  toast.textContent = message; toast.classList.add('on'); clearTimeout(filesToastTimer);
  filesToastTimer = setTimeout(() => toast.classList.remove('on'), 3_500);
}

function renderRecentFiles(files) {
  const list = document.getElementById('files-recent');
  if (!files.length) { list.innerHTML = '<div class="files-empty">No recent files yet</div>'; return }
  list.innerHTML = files.slice(0, 4).map(file => `
    <div class="files-item ${ file.conflict ? 'files-conflict' : '' }">
      <span class="files-item-icon">${ file.conflict ? '!' : file.mime?.startsWith('video/') ? '▶' : file.mime?.startsWith('image/') ? '▣' : '☰' }</span>
      <div class="files-item-copy"><b>${ escapeText(file.path.split('/').pop()) }</b><small>${ file.conflict ? 'Edited on two desktops · pick a version' : `${ relativeTime(file.updatedAt) } · ${ formatBytes(file.size) }` }</small></div>
      <button class="files-item-action" data-${ file.conflict ? 'resolve' : 'open' }="${ encodeURIComponent(file.path) }">${ file.conflict ? 'Resolve' : 'Open' }</button>
    </div>`).join('');
}

function renderRecentShares(shares, unavailable) {
  const list = document.getElementById('files-shares');
  if (unavailable) { list.innerHTML = '<div class="files-empty">Sharing comes online when links ship</div>'; return }
  if (!shares.length) { list.innerHTML = '<div class="files-empty">No shared links yet</div>'; return }
  list.innerHTML = shares.slice(0, 3).map(share => {
    const expiry = share.expiresAt ? `expires ${ relativeTime(share.expiresAt).replace(' ago', '') }` : 'no expiry';
    const mode = share.password ? 'password' : share.mode;

    return `<div class="files-item"><span class="files-item-icon">↗</span><div class="files-item-copy"><b>${ escapeText(share.name) }</b><small>${ escapeText(mode) } · ${ escapeText(expiry) } · ${ Number(share.viewCount) || 0 } views</small></div><button class="files-item-action" data-copy="${ encodeURIComponent(share.url) }">Copy</button></div>`;
  }).join('');
}

function updateFilesSync(status) {
  const state = status.state || 'error';
  document.getElementById('files-sync-dot').className = `dot ${ state === 'synced' ? 'running' : state === 'syncing' ? 'starting' : state === 'paused' ? 'off' : 'error' }`;
  document.getElementById('files-sync-title').textContent = state === 'synced' ? 'Everything is synced' : state === 'paused' ? 'Sync paused' : state === 'conflict' ? 'Sync needs attention' : state === 'syncing' ? `Syncing ${ status.pendingFiles } file${ status.pendingFiles === 1 ? '' : 's' }` : 'Files are local-only';
  const total = Number(status.totalBytes) || 0; const done = Number(status.processedBytes) || 0;
  document.getElementById('files-sync-detail').textContent = state === 'syncing' && total ? `${ formatBytes(done) } of ${ formatBytes(total) } · about ${ Math.max(1, Math.round(status.estimatedSeconds || 0)) } s left` : status.lastError || (status.serverLabel ? `Available on ${ status.serverLabel }` : 'Available on this computer');
  document.getElementById('files-progress-bar').style.width = total ? `${ Math.min(100, Math.round(done / total * 100)) }%` : state === 'synced' ? '100%' : '0%';
}

async function refreshFilesDashboard() {
  try {
    const dashboard = await ipcRenderer.invoke('tray-panel:files-dashboard');
    updateFilesSync(dashboard.status); renderRecentFiles(dashboard.files || []); renderRecentShares(dashboard.shares || [], dashboard.sharingUnavailable);
    filesMic = dashboard.preferences.recordMic !== false; filesCam = dashboard.preferences.recordCamera === true;
    document.getElementById('files-mic').classList.toggle('on', filesMic); document.getElementById('files-cam').classList.toggle('on', filesCam);
  } catch (error) { showFilesToast(error.message || 'Files are temporarily unavailable') }
}

document.querySelectorAll('[data-shot]').forEach(button => button.addEventListener('click', async() => {
  try { await ipcRenderer.invoke('tray-panel:capture-screenshot', button.dataset.shot) } catch (error) { if (!error.cancelled) showFilesToast(error.message || 'Screenshot failed') }
}));
document.getElementById('files-record').addEventListener('click', async() => {
  try {
    const result = await ipcRenderer.invoke('tray-panel:capture-record', { mic: filesMic, camera: filesCam }); filesRecording = result.recording;
    document.getElementById('files-record-state').textContent = filesRecording ? 'Recording · click again to stop' : result.error || 'Capture Studio recorder';
    document.getElementById('files-record').classList.toggle('on', filesRecording);
  } catch (error) { showFilesToast(error.message || 'Recording failed') }
});
for (const [id, key] of [['files-mic', 'record-mic'], ['files-cam', 'record-cam']]) document.getElementById(id).addEventListener('click', () => {
  if (id === 'files-mic') filesMic = !filesMic; else filesCam = !filesCam;
  document.getElementById(id).classList.toggle('on', id === 'files-mic' ? filesMic : filesCam);
  ipcRenderer.send('tray-panel:set-capture-toggle', key, id === 'files-mic' ? filesMic : filesCam);
});

async function uploadAndShare() {
  try {
    const capture = await ipcRenderer.invoke('tray-panel:capture-upload'); if (!capture) return;
    const result = await ipcRenderer.invoke('tray-panel:share-capture', capture, { mode: document.getElementById('files-upload-mode').value, keepAvailable: false });
    showFilesToast(result.message); void refreshFilesDashboard();
  } catch (error) { showFilesToast(error.message || 'Upload failed') }
}
document.getElementById('files-upload').addEventListener('click', uploadAndShare);
ipcRenderer.on('tray-panel:shortcut-upload', uploadAndShare);
document.getElementById('files-pause-hour').addEventListener('click', async() => { await ipcRenderer.invoke('tray-panel:files-pause-hour'); showFilesToast('Sync paused for 1 hour'); void refreshFilesDashboard() });
document.getElementById('files-open-folder').addEventListener('click', () => ipcRenderer.send('tray-panel:files-open'));
document.getElementById('files-open-sulla').addEventListener('click', () => ipcRenderer.send('tray-panel:open-main'));
document.getElementById('files-preferences').addEventListener('click', () => ipcRenderer.send('tray-panel:files-preferences', 'capture'));
document.getElementById('files-all-files').addEventListener('click', () => ipcRenderer.send('tray-panel:open-files-screen'));
document.getElementById('files-all-shares').addEventListener('click', () => ipcRenderer.send('tray-panel:open-files-screen', 'shared-by-me'));
document.getElementById('panel-files').addEventListener('click', event => {
  const button = event.target.closest('[data-open],[data-resolve],[data-copy]'); if (!button) return;
  if (button.dataset.copy) { const url = decodeURIComponent(button.dataset.copy); ipcRenderer.invoke('tray-panel:copy-share', url); showFilesToast('Link copied') }
  else if (button.dataset.resolve) ipcRenderer.send('tray-panel:resolve-file', decodeURIComponent(button.dataset.resolve));
  else ipcRenderer.send('tray-panel:open-file', decodeURIComponent(button.dataset.open));
});
