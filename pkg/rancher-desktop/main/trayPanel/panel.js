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
document.getElementById('login-form').addEventListener('submit', async (e) => {
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

sidebarBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-panel');

    // Update sidebar active state
    sidebarBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Show target panel
    panels.forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`panel-${target}`);
    if (panel) panel.classList.add('active');
  });
});

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

document.getElementById('btn-open-editor').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-editor');
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

// Settings panel buttons
document.getElementById('btn-premium-support').addEventListener('click', () => {
  ipcRenderer.send('tray-panel:open-url', 'https://www.skool.com/book-more-appointments-8103');
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
  STOPPED:  { cls: 'off',      label: 'Stopped' },
  STARTING: { cls: 'starting', label: 'Starting...' },
  STARTED:  { cls: 'running',  label: 'Running' },
  STOPPING: { cls: 'starting', label: 'Stopping...' },
  ERROR:    { cls: 'error',    label: 'Error' },
  DISABLED: { cls: 'off',      label: 'Disabled' },
};

function updateDot(dotEl, statusEl, state) {
  const mapped = STATE_MAP[state] || STATE_MAP.STOPPED;
  dotEl.className = `dot ${mapped.cls}`;
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
    document.getElementById('k8s-status').textContent += ` (${state.k8sContext})`;
  }

  if (state.extensions) {
    renderExtensions(state.extensions);
  }
});

// ── Extensions rendering ────────────────────────────────────────────────

function renderExtensions(extensions) {
  const list = document.getElementById('extensions-list');

  if (!extensions || extensions.length === 0) {
    list.innerHTML = '<span class="empty-text">No extensions installed</span>';
    return;
  }

  list.innerHTML = extensions.map(ext => `
    <button class="ext-item" data-url="${ext.url}">
      <span class="ext-icon">${ext.label.charAt(0).toUpperCase()}</span>
      ${ext.label}
    </button>
  `).join('');

  // Attach click handlers
  list.querySelectorAll('.ext-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.getAttribute('data-url');
      if (url) ipcRenderer.send('tray-panel:open-url', url);
    });
  });
}
