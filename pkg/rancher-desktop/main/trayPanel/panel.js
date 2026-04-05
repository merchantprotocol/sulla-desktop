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

// ── Audio panel — meters (ported from audio-driver/src/renderer/view/meters.js) ──

const PEAK_DECAY = 0.02;

function levelToPercent(level) {
  return Math.min(100, Math.pow(level, 0.5) * 100);
}

function levelToDb(level) {
  if (level <= 0.0001) return '-\u221E';
  return (20 * Math.log10(level)).toFixed(0) + ' dB';
}

function createMeter(barId, peakId, dbId) {
  const bar = document.getElementById(barId);
  const peak = document.getElementById(peakId);
  const dbLabel = document.getElementById(dbId);
  const peakState = { val: 0 };

  return {
    update(level) {
      const pct = levelToPercent(level);
      bar.style.width = pct + '%';
      dbLabel.textContent = levelToDb(level);

      if (pct > peakState.val) {
        peakState.val = pct;
      } else {
        peakState.val = Math.max(0, peakState.val - PEAK_DECAY * 100);
      }
      peak.style.left = peakState.val + '%';
      peak.style.opacity = peakState.val > 1 ? '0.8' : '0';
    },
  };
}

// ── Audio panel — volume controls (ported from audio-driver/src/renderer/view/controls.js) ──

const VOL_STEP = 10;

function createControl(muteBtnId, volDownId, volUpId, labelId) {
  const muteBtn = document.getElementById(muteBtnId);
  const volDownBtn = document.getElementById(volDownId);
  const volUpBtn = document.getElementById(volUpId);
  const label = document.getElementById(labelId);

  let muted = false;
  let volume = 100;
  let onMuteChange = null;
  let onVolumeChange = null;

  function render() {
    muteBtn.classList.toggle('muted', muted);
    label.textContent = muted ? '\u2014' : volume + '%';
  }

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    render();
    if (onMuteChange) onMuteChange(muted);
  });

  let onVolDown = null;
  let onVolUp = null;

  volDownBtn.addEventListener('click', () => {
    volume = Math.max(0, volume - VOL_STEP);
    if (muted) muted = false;
    render();
    if (onVolDown) onVolDown(volume / 100);
    else if (onVolumeChange) onVolumeChange(volume / 100);
  });

  volUpBtn.addEventListener('click', () => {
    volume = Math.min(100, volume + VOL_STEP);
    if (muted) muted = false;
    render();
    if (onVolUp) onVolUp(volume / 100);
    else if (onVolumeChange) onVolumeChange(volume / 100);
  });

  render();

  return {
    onMute(fn) { onMuteChange = fn; },
    onVolume(fn) { onVolumeChange = fn; },
    onVolumeDown(fn) { onVolDown = fn; },
    onVolumeUp(fn) { onVolUp = fn; },
    isMuted() { return muted; },
    getVolume() { return volume / 100; },
    setMuted(m) { muted = m; render(); },
    setVolume(v) { volume = Math.round(v * 100); render(); },
  };
}

// ── Audio panel — initialize meters & controls ──────────────────────────

const micMeter = createMeter('mic-bar', 'mic-peak', 'mic-db');
const speakerMeter = createMeter('speaker-bar', 'speaker-peak', 'speaker-db');
const micControl = createControl('mic-mute-btn', 'mic-vol-down', 'mic-vol-up', 'mic-volume-label');
const speakerControl = createControl('speaker-mute-btn', 'speaker-vol-down', 'speaker-vol-up', 'speaker-volume-label');

// Forward control changes to main process
micControl.onMute((muted) => ipcRenderer.send('tray-panel:audio-mic-mute', muted));
micControl.onVolume((vol) => ipcRenderer.send('tray-panel:audio-mic-volume', vol));
speakerControl.onMute((muted) => ipcRenderer.send('tray-panel:audio-speaker-mute', muted));
speakerControl.onVolume((vol) => ipcRenderer.send('tray-panel:audio-speaker-volume', vol));

// Toggle audio capture on/off
document.getElementById('audio-enabled-toggle').addEventListener('change', (e) => {
  ipcRenderer.send('tray-panel:audio-toggle', e.target.checked);
});

// Device selection changes
document.getElementById('mic-device').addEventListener('change', (e) => {
  ipcRenderer.send('tray-panel:audio-mic-device', e.target.value);
});
document.getElementById('speaker-device').addEventListener('change', (e) => {
  ipcRenderer.send('tray-panel:audio-speaker-device', e.target.value);
});

// ── Audio panel — state updates from main process ───────────────────────

function renderAudioState(state) {
  const msg = state.message || (state.running ? 'Capturing' : 'Off');
  const isTransitioning = msg === 'Enabling...' || msg === 'Disabling...';
  const dotClass = isTransitioning ? 'transitioning' : (state.running ? 'running' : 'off');

  document.getElementById('audio-status-dot').className = 'dot ' + dotClass;
  document.getElementById('audio-status-text').textContent = msg;
  document.getElementById('audio-enabled-toggle').checked = state.running || isTransitioning;
  document.getElementById('audio-enabled-toggle').disabled = isTransitioning;

  document.querySelectorAll('#panel-audio .meter-section').forEach((s) => {
    s.classList.toggle('disabled', !state.running);
  });
}

function populateDeviceSelect(selectId, devices, activeDeviceId) {
  const select = document.getElementById(selectId);
  const currentValue = select.value;
  select.innerHTML = '';
  devices.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label;
    if (d.deviceId === activeDeviceId || d.deviceId === currentValue) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

ipcRenderer.on('tray-panel:audio-state', (_event, state) => {
  renderAudioState(state);
});

ipcRenderer.on('tray-panel:audio-mic-level', (_event, level) => {
  micMeter.update(level);
});

ipcRenderer.on('tray-panel:audio-speaker-level', (_event, level) => {
  speakerMeter.update(level);
});

ipcRenderer.on('tray-panel:audio-devices', (_event, { inputs, outputs, activeInput, activeOutput }) => {
  populateDeviceSelect('mic-device', inputs, activeInput);
  populateDeviceSelect('speaker-device', outputs, activeOutput);
});

ipcRenderer.on('tray-panel:audio-detection', (_event, { statusDotClass, statusText, noisePct, noiseLevel, noiseLabel, feedbackPct, feedbackLabel }) => {
  // Update status dot
  document.getElementById('audio-status-dot').className = 'dot ' + statusDotClass;
  document.getElementById('audio-status-text').textContent = statusText;

  // Show detection bars when capturing
  const detectionEl = document.getElementById('detection-bar');
  if (detectionEl) detectionEl.classList.remove('hidden');

  // Noise meter
  const noiseBar = document.getElementById('noise-bar');
  if (noiseBar) {
    noiseBar.style.width = noisePct + '%';
    noiseBar.className = 'meter-fill noise-' + noiseLevel;
  }
  const noiseLabelEl = document.getElementById('noise-label');
  if (noiseLabelEl) noiseLabelEl.textContent = noiseLabel;

  // Feedback meter
  const feedbackBar = document.getElementById('feedback-bar');
  if (feedbackBar) feedbackBar.style.width = feedbackPct + '%';
  const feedbackLabelEl = document.getElementById('feedback-label');
  if (feedbackLabelEl) feedbackLabelEl.textContent = feedbackLabel;
});

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
