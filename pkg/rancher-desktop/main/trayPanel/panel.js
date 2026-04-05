/**
 * Tray panel renderer — sidebar switching, state updates, button handlers.
 * Uses nodeIntegration (like audio driver) — no preload needed.
 */

const { ipcRenderer } = require('electron');

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
