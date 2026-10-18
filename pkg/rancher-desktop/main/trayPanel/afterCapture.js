const { ipcRenderer } = require('electron');

let capture;
let preferences = {};
let seconds = 4;
let timer;
let closeTimer;
let working = false;
let done = false;

const $ = id => document.getElementById(id);

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);

  return `${ (Number(bytes) / (1024 ** index)).toFixed(index > 1 ? 1 : 0) } ${ units[index] }`;
}

// Fit the transparent window to whichever card is showing.
function fitWindow() {
  window.requestAnimationFrame(() => ipcRenderer.send('files-after-capture:resize', Math.ceil(document.body.scrollHeight)));
}

function close() { clearInterval(timer); clearTimeout(closeTimer); ipcRenderer.send('files-after-capture:close') }

function paintPreview(node) {
  node.className = 'th'; node.innerHTML = '';
  if (capture.kind === 'recording') { node.classList.add('dark'); return }
  if (!/\.(png|jpe?g|gif|webp)$/i.test(capture.name)) return;
  const image = new window.Image();
  image.onload = () => { node.classList.add('img'); node.appendChild(image) };
  image.src = `file://${ encodeURI(capture.path) }`;
}

function showToast(title, detail, success) {
  $('postcap').hidden = true; $('toast').hidden = false;
  $('toast-title').textContent = title; $('toast-detail').textContent = detail;
  $('toast-icon').classList.toggle('warn', !success);
  $('markup').hidden = capture.kind !== 'screenshot';
  paintPreview($('toast-preview')); fitWindow();
  scheduleClose(8_000);
}

function scheduleClose(ms) { clearTimeout(closeTimer); closeTimer = setTimeout(close, ms) }

async function share() {
  if (!capture || working || done) return;
  working = true; clearInterval(timer); $('countdown').classList.remove('err'); $('countdown').textContent = 'creating link…';
  try {
    const result = await ipcRenderer.invoke('tray-panel:share-capture', capture, { mode: preferences.visitorMode || 'view', keepAvailable: $('keep').classList.contains('on') });
    done = true;
    if (result.url) showToast('Link copied', result.url.replace(/^https?:\/\//, ''), true);
    else showToast('Saved to Files', result.message, false);
  } catch (error) {
    $('countdown').classList.add('err'); $('countdown').textContent = error.message || 'Sharing failed. The capture is saved in Files.'; fitWindow();
  } finally { working = false }
}

function beginCountdown(action) {
  clearInterval(timer); seconds = 4;
  const label = () => (action === 'save' ? `closes in ${ seconds } s` : `auto-shares in ${ seconds } s`);
  $('countdown').textContent = label();
  timer = setInterval(() => {
    seconds -= 1;
    if (seconds > 0) { $('countdown').textContent = label(); return }
    clearInterval(timer);
    if (action === 'save') close(); else share();
  }, 1_000);
}

function stopCountdown() { if (!working && !done) { clearInterval(timer); $('countdown').textContent = '' } }

ipcRenderer.on('files-after-capture:show', async(_event, value) => {
  capture = value; done = false;
  try { preferences = await ipcRenderer.invoke('tray-panel:files-preferences-get') } catch { preferences = {} }
  const folders = String(capture.relativePath || '').split('/').slice(0, -1);
  $('capture-title').textContent = capture.kind === 'recording' ? 'Recording captured' : capture.kind === 'upload' ? 'File added to Files' : 'Screenshot captured';
  $('capture-detail').textContent = [capture.name, formatBytes(capture.size), ['Files', ...folders].join(' › ')].join(' · ');
  paintPreview($('preview'));
  const expiryDays = Number(preferences.expiryDays ?? 30);
  $('share-detail').textContent = ['Public link', preferences.visitorMode === 'download' ? 'download' : 'view only', expiryDays > 0 ? `expires in ${ expiryDays } days` : 'never expires'].join(' · ');
  $('keep').classList.toggle('on', preferences.keepCapturesAvailable !== false);
  const action = preferences.defaultAction === 'save' || preferences.defaultAction === 'ask' ? preferences.defaultAction : 'share';
  $('share').classList.toggle('on', action === 'share'); $('share').classList.toggle('default', action === 'share');
  $('save').classList.toggle('on', action === 'save'); $('save').classList.toggle('default', action === 'save');
  if (action === 'ask') $('countdown').textContent = 'choose an action';
  else beginCountdown(action);
  fitWindow();
});

$('share').addEventListener('click', share);
$('save').addEventListener('click', close);
$('close').addEventListener('click', close);
$('keep').addEventListener('click', () => { $('keep').classList.toggle('on'); $('keep').setAttribute('aria-checked', String($('keep').classList.contains('on'))); stopCountdown() });
$('markup').addEventListener('click', async() => {
  if (capture?.kind !== 'screenshot') return;
  try {
    await ipcRenderer.invoke('tray-panel:markup', capture.path);
    close();
  } catch (error) {
    $('countdown').classList.add('err'); $('countdown').textContent = error.message || 'Could not open markup'; fitWindow();
  }
});
const openPreferences = (event) => { event.preventDefault(); ipcRenderer.send('tray-panel:files-preferences', 'capture'); stopCountdown() };
$('preferences').addEventListener('click', openPreferences);
$('preferences-link').addEventListener('click', openPreferences);
$('toast').addEventListener('mouseenter', () => clearTimeout(closeTimer));
$('toast').addEventListener('mouseleave', () => scheduleClose(3_000));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('postcap').hidden) share();
  else if (event.key === 'Escape') close();
});
