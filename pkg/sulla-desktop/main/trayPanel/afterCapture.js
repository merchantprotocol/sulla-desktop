// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const { ipcRenderer } = require('electron');

let capture;
let preferences = {};
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

function close() { clearTimeout(closeTimer); ipcRenderer.send('files-after-capture:close') }

function paintPreview(node) {
  node.className = 'th'; node.innerHTML = '';
  if (capture.kind === 'recording') { node.classList.add('dark'); return }
  if (!capture.path || !/\.(png|jpe?g|gif|webp)$/i.test(capture.name)) return;
  const image = new window.Image();
  image.onload = () => { node.classList.add('img'); node.appendChild(image) };
  image.src = `file://${ encodeURI(capture.path) }`;
}

function scheduleClose(ms) { clearTimeout(closeTimer); closeTimer = setTimeout(close, ms) }

function finishAction(button) {
  done = true; button.classList.add('selected');
  scheduleClose(450);
}

async function share() {
  if (!capture || working || done) return;
  working = true; $('countdown').classList.remove('err'); $('countdown').textContent = 'creating link…';
  try {
    const result = await ipcRenderer.invoke('tray-panel:share-popup-capture', { mode: preferences.visitorMode || 'view' });
    if (!result.url) throw new Error(result.message || 'Sharing failed.');
    finishAction($('share'));
  } catch (error) {
    $('countdown').classList.add('err'); $('countdown').textContent = error.message || 'Sharing failed.'; fitWindow();
  } finally { working = false }
}

async function saveToFiles() {
  if (!capture || working || done) return;
  working = true; $('countdown').classList.remove('err'); $('countdown').textContent = 'saving capture…';
  try {
    const savedPath = await ipcRenderer.invoke('tray-panel:copy-capture-path');
    if (savedPath) finishAction($('save'));
    else $('countdown').textContent = 'select an action to continue';
  } catch (error) {
    $('countdown').classList.add('err'); $('countdown').textContent = error.message || 'Could not save the capture.'; fitWindow();
  } finally { working = false }
}

function stopCountdown() { if (!working && !done) $('countdown').textContent = '' }

ipcRenderer.on('files-after-capture:show', async(_event, value) => {
  capture = value; done = false;
  try { preferences = await ipcRenderer.invoke('tray-panel:files-preferences-get') } catch { preferences = {} }
  const folders = String(capture.relativePath || '').split('/').slice(0, -1);
  $('capture-title').textContent = capture.kind === 'recording' ? 'Recording captured' : capture.kind === 'upload' ? 'File added to Files' : 'Screenshot captured';
  $('capture-detail').textContent = [capture.name, formatBytes(capture.size), capture.relativePath ? ['Files', ...folders].join(' › ') : undefined].filter(Boolean).join(' · ');
  paintPreview($('preview'));
  const expiryDays = Number(preferences.expiryDays ?? 30);
  $('share-detail').textContent = ['Public link', preferences.visitorMode === 'download' ? 'download' : 'view only', expiryDays > 0 ? `expires in ${ expiryDays } days` : 'never expires'].join(' · ');
  const action = preferences.defaultAction === 'save' || preferences.defaultAction === 'ask' ? preferences.defaultAction : 'share';
  $('share').classList.toggle('on', action === 'share'); $('share').classList.toggle('default', action === 'share');
  $('save').classList.toggle('on', action === 'save'); $('save').classList.toggle('default', action === 'save');
  $('countdown').textContent = action === 'ask' ? 'choose an action' : 'select an action to continue';
  fitWindow();
});

$('share').addEventListener('click', share);
$('save').addEventListener('click', saveToFiles);
$('close').addEventListener('click', close);
const openPreferences = (event) => { event.preventDefault(); ipcRenderer.send('tray-panel:files-preferences', 'capture'); stopCountdown() };
$('preferences-link').addEventListener('click', openPreferences);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('postcap').hidden) {
    if ($('save').classList.contains('on')) saveToFiles(); else share();
  }
  else if (event.key === 'Escape') close();
});
