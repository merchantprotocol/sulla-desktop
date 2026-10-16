const { ipcRenderer } = require('electron');

let capture;
let preferences;
let seconds = 4;
let timer;
let working = false;

function close() { clearInterval(timer); ipcRenderer.send('files-after-capture:close') }
function showMessage(message, success = false) {
  const node = document.getElementById('message'); node.textContent = message; node.className = `message on${ success ? ' success' : '' }`;
}
async function share() {
  if (!capture || working) return; working = true; clearInterval(timer); document.getElementById('countdown').textContent = 'Creating link…';
  try {
    const result = await ipcRenderer.invoke('tray-panel:share-capture', capture, { mode: preferences.visitorMode || 'view', keepAvailable: document.getElementById('keep').checked });
    showMessage(result.message, Boolean(result.url)); document.getElementById('countdown').textContent = result.url ? 'Link copied' : 'Saved to Files';
  } catch (error) { showMessage(error.message || 'Sharing failed'); document.getElementById('countdown').textContent = 'Saved to Files' }
  finally { working = false }
}
function beginCountdown() {
  clearInterval(timer); seconds = 4; document.getElementById('countdown').textContent = 'Sharing in 4 s';
  timer = setInterval(() => { seconds -= 1; document.getElementById('countdown').textContent = `Sharing in ${ seconds } s`; if (seconds <= 0) share() }, 1_000);
}

ipcRenderer.on('files-after-capture:show', async(_event, value) => {
  capture = value; preferences = await ipcRenderer.invoke('tray-panel:files-preferences-get');
  document.getElementById('capture-name').textContent = capture.name; document.getElementById('capture-path').textContent = capture.relativePath;
  document.getElementById('keep').checked = preferences.keepCapturesAvailable !== false;
  document.getElementById('share-detail').textContent = `Visitors can ${ preferences.visitorMode === 'download' ? 'download' : 'view' } · expires in ${ preferences.expiryDays || 30 } days`;
  if (preferences.defaultAction === 'save') { document.getElementById('share').classList.remove('selected'); document.getElementById('save').classList.add('selected'); document.getElementById('countdown').textContent = 'Saved to Files' }
  else if (preferences.defaultAction === 'ask') document.getElementById('countdown').textContent = 'Choose an action';
  else beginCountdown();
});
document.getElementById('share').addEventListener('click', share);
document.getElementById('save').addEventListener('click', close);
document.getElementById('close').addEventListener('click', close);
document.getElementById('markup').addEventListener('click', () => { if (capture?.kind === 'screenshot') ipcRenderer.send('tray-panel:markup', capture.path) });
document.getElementById('preferences').addEventListener('click', () => ipcRenderer.send('tray-panel:files-preferences', 'capture'));
document.addEventListener('keydown', event => { if (event.key === 'Enter') share(); else if (event.key === 'Escape') close() });
