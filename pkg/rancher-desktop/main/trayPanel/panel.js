const { ipcRenderer } = require('electron');

let screenshotMode = 'area';
let uploadMode = 'view';
let latestCapture = null;
let countdownTimer = null;
let countdownRemaining = 0;
let preferences = { defaultAction: 'share', keepCapturesAvailable: true, expiryDays: 30, visitorMode: 'view' };

const $ = id => document.getElementById(id);

function bytes(value) {
  const number = Number(value || 0);
  if (number < 1024) return `${ number } B`;
  if (number < 1024 ** 2) return `${ (number / 1024).toFixed(1) } KB`;
  if (number < 1024 ** 3) return `${ (number / 1024 ** 2).toFixed(1) } MB`;
  return `${ (number / 1024 ** 3).toFixed(1) } GB`;
}

function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return `${ Math.max(1, Math.round(elapsed / 1_000)) } s ago`;
  if (elapsed < 3_600_000) return `${ Math.round(elapsed / 60_000) } min ago`;
  if (elapsed < 86_400_000) return `${ Math.round(elapsed / 3_600_000) } h ago`;
  return `${ Math.round(elapsed / 86_400_000) } d ago`;
}

function expiry(value) {
  const remaining = new Date(value).getTime() - Date.now();
  if (remaining <= 0) return 'expired';
  if (remaining < 86_400_000) return `expires in ${ Math.max(1, Math.ceil(remaining / 3_600_000)) } h`;
  return `expires in ${ Math.ceil(remaining / 86_400_000) } d`;
}

function selectSegment(container, value) {
  container.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.value === value));
}

function showToast(title, detail = '', canMarkup = false) {
  $('toast-title').textContent = title;
  $('toast-detail').textContent = detail;
  $('markup-button').classList.toggle('hidden', !canMarkup);
  $('toast').classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $('toast').classList.add('hidden'), 6000);
}

function updateStatus(status) {
  const dot = $('sync-dot'); dot.className = `status-dot ${ status.state }`;
  const state = status.state === 'syncing' ? `Syncing ${ status.pendingFiles || 0 } file${ status.pendingFiles === 1 ? '' : 's' }` : status.state === 'synced' ? 'Everything is synced' : status.state === 'paused' ? 'Sync paused for 1 hour' : 'Files needs attention';
  $('sync-title').textContent = state;
  if (status.state === 'syncing') {
    const total = Number(status.totalBytes || 0); const done = Number(status.processedBytes || 0);
    $('sync-detail').textContent = `${ bytes(done) } of ${ bytes(total) }${ status.estimatedSeconds ? ` · about ${ status.estimatedSeconds } s left` : '' }`;
    $('sync-progress').style.width = total ? `${ Math.min(100, done / total * 100) }%` : '18%';
  } else {
    $('sync-detail').textContent = status.lastError || (status.serverConfigured ? 'Sulla Server · up to date' : 'This computer · versioned locally');
    $('sync-progress').style.width = status.state === 'synced' ? '100%' : '0';
  }
}

function itemShell(icon, name, detail) {
  const row = document.createElement('div'); row.className = 'item';
  const image = document.createElement('span'); image.className = 'file-icon'; image.textContent = icon;
  const copy = document.createElement('div'); copy.className = 'grow';
  const strong = document.createElement('strong'); strong.textContent = name;
  const small = document.createElement('small'); small.textContent = detail;
  copy.append(strong, small); row.append(image, copy);
  return row;
}

function renderFiles(files) {
  const list = $('recent-files'); list.replaceChildren();
  if (!files.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Files you capture or add will appear here.'; list.append(empty); return }
  files.slice(0, 4).forEach(file => {
    const name = file.path.split('/').pop(); const row = itemShell(file.mime?.startsWith('video/') ? '▶' : file.mime?.startsWith('image/') ? '▣' : '◇', name, `${ file.path.includes('/') ? file.path.split('/').slice(0, -1).join(' › ') : 'Files' } · ${ relativeTime(file.updatedAt) }`);
    row.classList.toggle('conflict', file.conflict);
    if (file.conflict) row.querySelector('small').textContent = 'Edited on two desktops · pick a version';
    const action = document.createElement('button'); action.className = 'row-action'; action.textContent = file.conflict ? 'Resolve' : '↗';
    action.addEventListener('click', () => ipcRenderer.send(file.conflict ? 'tray-panel:resolve-file' : 'tray-panel:open-file', file.path));
    row.append(action); list.append(row);
  });
}

function renderShares(shares, unavailable) {
  const list = $('recent-shares'); list.replaceChildren();
  if (unavailable) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Sharing comes online when links ship.'; list.append(empty); return }
  if (!shares.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Shared links will appear here.'; list.append(empty); return }
  shares.slice(0, 3).forEach(share => {
    const mode = share.password ? 'password' : share.mode === 'download' ? 'download' : 'view only';
    const row = itemShell('↗', share.name, `${ share.url.replace(/^https?:\/\//, '') } · ${ mode }${ share.expiresAt ? ` · ${ expiry(share.expiresAt) }` : '' }`);
    const views = document.createElement('span'); views.className = 'share-meta'; views.textContent = `◉ ${ share.viewCount || 0 }`;
    const action = document.createElement('button'); action.className = 'row-action'; action.textContent = 'Copy'; action.addEventListener('click', () => ipcRenderer.invoke('tray-panel:copy-share', share.url).then(() => showToast('Link copied', share.url)));
    row.append(views, action); list.append(row);
  });
}

async function refresh() {
  try {
    const dashboard = await ipcRenderer.invoke('tray-panel:files-dashboard');
    preferences = { ...preferences, ...dashboard.preferences };
    $('record-mic').checked = preferences.recordMic !== false;
    $('record-cam').checked = preferences.recordCamera === true;
    updateStatus(dashboard.status); renderFiles(dashboard.files || []); renderShares(dashboard.shares || [], dashboard.sharingUnavailable);
  } catch (error) { updateStatus({ state: 'error', lastError: String(error), serverConfigured: false }) }
}

function stopCountdown() { if (countdownTimer) clearInterval(countdownTimer); countdownTimer = null }

function showCapture(capture) {
  latestCapture = capture; stopCountdown();
  $('capture-title').textContent = capture.kind === 'recording' ? 'Recording saved' : capture.kind === 'upload' ? 'File added' : 'Screenshot captured';
  $('capture-meta').textContent = `${ capture.name } · ${ bytes(capture.size) } · Files › ${ capture.relativePath.split('/')[0] }`;
  $('capture-preview').textContent = capture.kind === 'recording' ? '▶' : capture.kind === 'upload' ? '↗' : '▣';
  $('keep-available').checked = preferences.keepCapturesAvailable !== false;
  $('share-description').textContent = `share.sulla.cloud · ${ preferences.visitorMode === 'download' ? 'download' : 'view only' }${ preferences.expiryDays ? ` · expires in ${ preferences.expiryDays } days` : '' }`;
  $('capture-card').classList.remove('hidden');
  if (preferences.defaultAction === 'share') {
    countdownRemaining = 4; $('countdown').textContent = `auto-shares in ${ countdownRemaining } s`;
    countdownTimer = setInterval(() => { countdownRemaining--; $('countdown').textContent = countdownRemaining > 0 ? `auto-shares in ${ countdownRemaining } s` : 'sharing…'; if (countdownRemaining <= 0) { stopCountdown(); shareCapture() } }, 1000);
  } else if (preferences.defaultAction === 'save') {
    $('countdown').textContent = 'saved to Files';
  } else $('countdown').textContent = 'choose an action';
}

function dismissCapture() { stopCountdown(); $('capture-card').classList.add('hidden'); latestCapture = null; refresh() }

async function shareCapture() {
  if (!latestCapture) return;
  stopCountdown(); $('countdown').textContent = 'sharing…';
  try {
    const result = await ipcRenderer.invoke('tray-panel:share-capture', latestCapture, { mode: preferences.visitorMode || 'view', keepAvailable: $('keep-available').checked });
    $('capture-card').classList.add('hidden');
    showToast(result.message, result.url || '', latestCapture.kind === 'screenshot');
    await refresh();
  } catch (error) { $('countdown').textContent = String(error) }
}

async function takeScreenshot() {
  $('screenshot-subtitle').textContent = 'Choose the area to capture…';
  try { const result = await ipcRenderer.invoke('tray-panel:capture-screenshot', screenshotMode); if (result) showCapture(result) } catch (error) { if (!String(error).toLowerCase().includes('cancel')) showToast('Screenshot failed', String(error)) }
  $('screenshot-subtitle').textContent = 'Shares online · link copied';
}

async function toggleRecording() {
  $('record-title').textContent = $('record-title').textContent === 'Stop recording' ? 'Saving recording…' : 'Starting…';
  try {
    const result = await ipcRenderer.invoke('tray-panel:capture-record', { mic: $('record-mic').checked, camera: $('record-cam').checked });
    $('record-title').textContent = result.recording ? 'Stop recording' : 'Record screen';
    if (result.capture) showCapture(result.capture); else if (result.error) showToast('Recording', result.error);
  } catch (error) { $('record-title').textContent = 'Record screen'; showToast('Recording failed', String(error)) }
}

async function upload() {
  try {
    const capture = await ipcRenderer.invoke('tray-panel:capture-upload'); if (!capture) return;
    latestCapture = capture; const result = await ipcRenderer.invoke('tray-panel:share-capture', capture, { mode: uploadMode, keepAvailable: false });
    showToast(result.message, result.url || '', false); await refresh();
  } catch (error) { showToast('Upload saved to Files', String(error)) }
}

$('screenshot-mode').addEventListener('click', event => { event.stopPropagation(); const value = event.target?.dataset?.value; if (value) { screenshotMode = value; selectSegment($('screenshot-mode'), value) } });
$('upload-mode').addEventListener('click', event => { event.stopPropagation(); const value = event.target?.dataset?.value; if (value) { uploadMode = value; selectSegment($('upload-mode'), value) } });
$('screenshot-row').addEventListener('click', takeScreenshot);
$('record-row').addEventListener('click', event => { if (!event.target.closest('label')) toggleRecording() });
$('upload-row').addEventListener('click', upload);
['record-mic', 'record-cam'].forEach(id => $(id).addEventListener('change', () => ipcRenderer.send('tray-panel:set-capture-toggle', id, $(id).checked)));
$('share-capture').addEventListener('click', shareCapture);
$('save-capture').addEventListener('click', dismissCapture);
$('dismiss-capture').addEventListener('click', dismissCapture);
$('pause-sync').addEventListener('click', () => ipcRenderer.invoke('tray-panel:files-pause-hour').then(refresh));
$('footer-pause').addEventListener('click', () => ipcRenderer.invoke('tray-panel:files-pause-hour').then(refresh));
$('open-folder').addEventListener('click', () => ipcRenderer.send('tray-panel:files-open'));
$('open-sulla').addEventListener('click', () => ipcRenderer.send('tray-panel:open-main'));
$('unlock-main').addEventListener('click', () => ipcRenderer.send('tray-panel:open-main'));
$('open-preferences').addEventListener('click', () => ipcRenderer.send('tray-panel:files-preferences'));
$('capture-preferences').addEventListener('click', () => ipcRenderer.send('tray-panel:files-preferences', 'capture'));
$('toast-settings').addEventListener('click', () => ipcRenderer.send('tray-panel:files-preferences', 'capture'));
$('all-files').addEventListener('click', () => ipcRenderer.send('tray-panel:open-files-screen'));
$('all-shares').addEventListener('click', () => ipcRenderer.send('tray-panel:open-files-screen', 'shared'));
$('markup-button').addEventListener('click', () => latestCapture && ipcRenderer.send('tray-panel:markup', latestCapture.path));

document.addEventListener('keydown', event => {
  if (!$('capture-card').classList.contains('hidden')) {
    if (event.key === 'Enter') { event.preventDefault(); shareCapture() }
    if (event.key === 'Escape') { event.preventDefault(); dismissCapture() }
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'u') { event.preventDefault(); upload() }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === '5') { event.preventDefault(); takeScreenshot() }
});

ipcRenderer.on('tray-panel:capture-created', (_event, capture) => showCapture(capture));
ipcRenderer.on('tray-panel:shortcut-upload', () => upload());
ipcRenderer.on('tray-panel:auth-state', (_event, state) => $('locked').classList.toggle('hidden', state.loggedIn || !state.vaultSetUp));
ipcRenderer.invoke('tray-panel:check-auth').then(state => $('locked').classList.toggle('hidden', state.loggedIn || !state.vaultSetUp));

refresh(); setInterval(refresh, 5_000);
