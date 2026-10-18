const { ipcRenderer } = require('electron');

const state = {};
const tabs = [...document.querySelectorAll('[data-tab]')];
const pages = [...document.querySelectorAll('[data-page]')];

// macOS gets real traffic lights over the drawn bar; elsewhere the native frame is kept.
document.documentElement.classList.add(process.platform === 'darwin' ? 'native-lights' : 'native-frame');

function selectTab(tab) {
  tabs.forEach(link => link.classList.toggle('on', link.dataset.tab === tab));
  pages.forEach(page => page.classList.toggle('on', page.dataset.page === tab));
}

function paint(settings) {
  Object.assign(state, settings);
  document.querySelectorAll('[data-setting]').forEach((control) => {
    const value = state[control.dataset.setting];
    if (control.classList.contains('sw')) {
      control.classList.toggle('on', Boolean(value)); control.setAttribute('aria-checked', String(Boolean(value)));
    } else if (control.matches('select')) control.value = String(value);
    else control.querySelectorAll('button').forEach(button => button.classList.toggle('on', button.dataset.value === String(value)));
  });
  document.getElementById('save-location').textContent = `Files › ${ state.screenshotLocation || 'Screenshots' }`;
}

async function save(key, value) {
  paint({ [key]: value });
  paint(await ipcRenderer.invoke('tray-panel:files-preferences-set', key, value));
}

tabs.forEach(link => link.addEventListener('click', (event) => { event.preventDefault(); selectTab(link.dataset.tab) }));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.goto)));
document.querySelectorAll('.seg[data-setting]').forEach(group => group.addEventListener('click', (event) => {
  const value = event.target.closest('button')?.dataset.value;
  if (value !== undefined) save(group.dataset.setting, value);
}));
document.querySelectorAll('.sw[data-setting]').forEach(toggle => toggle.addEventListener('click', () => save(toggle.dataset.setting, !toggle.classList.contains('on'))));
document.querySelectorAll('select[data-setting]').forEach(select => select.addEventListener('change', () => save(select.dataset.setting, Number(select.value))));
document.getElementById('open-folder').addEventListener('click', async() => {
  try { await ipcRenderer.invoke('tray-panel:files-open') } catch (error) { window.alert(error.message || 'Could not open the Files folder') }
});
ipcRenderer.on('files-preferences:select-tab', (_event, tab) => selectTab(tab));

selectTab(new URLSearchParams(window.location.search).get('tab') || 'capture');
ipcRenderer.invoke('tray-panel:files-preferences-get').then(paint);
