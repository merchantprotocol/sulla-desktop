const { ipcRenderer } = require('electron');

const state = {};
const pages = [...document.querySelectorAll('[data-page]')];
const tabs = [...document.querySelectorAll('[data-tab]')];

function selectTab(tab) {
  tabs.forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  pages.forEach(page => page.classList.toggle('active', page.dataset.page === tab));
}

function paint(settings) {
  Object.assign(state, settings);
  document.querySelectorAll('[data-setting]').forEach(control => {
    const key = control.dataset.setting;
    if (control.matches('input')) control.checked = Boolean(state[key]);
    else if (control.matches('select')) control.value = String(state[key]);
    else control.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.value === String(state[key])));
  });
}

async function save(key, value) {
  document.getElementById('saved').textContent = 'Saving…';
  paint(await ipcRenderer.invoke('tray-panel:files-preferences-set', key, value));
  document.getElementById('saved').textContent = 'Saved';
  setTimeout(() => { document.getElementById('saved').textContent = 'Changes save automatically' }, 1200);
}

tabs.forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)));
document.querySelectorAll('.segments[data-setting]').forEach(group => group.addEventListener('click', event => {
  const value = event.target.dataset.value;
  if (value !== undefined) save(group.dataset.setting, value);
}));
document.querySelectorAll('input[data-setting]').forEach(input => input.addEventListener('change', () => save(input.dataset.setting, input.checked)));
document.querySelectorAll('select[data-setting]').forEach(select => select.addEventListener('change', () => save(select.dataset.setting, Number(select.value))));
document.getElementById('done').addEventListener('click', () => window.close());
ipcRenderer.on('files-preferences:select-tab', (_event, tab) => selectTab(tab));

selectTab(new URLSearchParams(location.search).get('tab') || 'capture');
ipcRenderer.invoke('tray-panel:files-preferences-get').then(paint);
