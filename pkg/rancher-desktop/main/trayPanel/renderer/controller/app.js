/**
 * Controller — wires model to views, handles user actions.
 *
 * Adapted for sulla-desktop tray panel.
 * Auth/account management is handled by sulla-desktop separately.
 * Sidebar switching is handled by panel.js.
 *
 * Delegates to:
 *   model/audio-capture.js — mic capture, gain, mute
 *   view/meters.js         — meter bar rendering
 *   view/status.js         — status, device selectors
 *   view/controls.js       — mute/volume controls
 */

const { createMeter } = require("../view/meters");
const { renderState, populateDeviceSelect, onDeviceChange } = require("../view/status");
const { createMicControl, createSpeakerControl } = require("../view/controls");
const audioCapture = require("../model/audio-capture");
const micSocket = require("../model/mic-socket");
const vad = require("../model/vad");
const speakerVad = require("../model/speaker-vad");
const feedbackDetection = require("../model/feedback-detection");
const callSession = require("../model/call-session");

const log = window.audioDriver.log;

// ─── Create view instances ───────────────────────────────────

const micMeter = createMeter("mic-bar", "mic-peak", "mic-db");
const speakerMeter = createMeter("speaker-bar", "speaker-peak", "speaker-db");
const micControl = createMicControl();
const speakerControl = createSpeakerControl();

// ─── Call session ───────────────────────────────────────────

const activeCallEl = document.getElementById("active-call");
const activeCallStatus = document.getElementById("active-call-status");
const activeCallTimer = document.getElementById("active-call-timer");
const endCallBtn = document.getElementById("end-call-btn");
const newCallSection = document.getElementById("new-call-section");
const newCallBtn = document.getElementById("new-call-btn");
const callsHistory = document.getElementById("calls-history");

let callTimerInterval = null;

// New call button
if (newCallBtn) {
  newCallBtn.addEventListener("click", async () => {
    log.info("Controller", "Manual new call started");
    callSession.startManual();
    const gatewaySessionId = await _startGatewayStreaming();
    _openTranscriptionSidebar(null, gatewaySessionId);
  });
}

// End call button
if (endCallBtn) {
  endCallBtn.addEventListener("click", () => {
    log.info("Controller", "Manual end call");
    callSession.endManual();
  });
}

// Auto-detection → show notification
callSession.onCallDetected((session) => {
  log.info("Controller", "Call auto-detected", { sessionId: session.sessionId });
  window.audioDriver.showCallNotification();
});

// Notification responses
window.audioDriver.onCallAccepted(async () => {
  log.info("Controller", "Call accepted via notification");
  callSession.accept();
  const gatewaySessionId = await _startGatewayStreaming();
  _openTranscriptionSidebar(null, gatewaySessionId);
});

window.audioDriver.onCallDismissed(() => {
  log.info("Controller", "Call dismissed via notification");
  callSession.dismiss();
});

// End call from transcription sidebar (red button)
window.audioDriver.onEndCall(() => {
  log.info("Controller", "End call from transcription sidebar");
  _stopGatewayStreaming();
  callSession.endManual();
});

// Session ended
callSession.onCallEnded((session) => {
  _stopGatewayStreaming();
  log.info("Controller", "Call ended", {
    sessionId: session.sessionId,
    duration: session.durationFormatted,
    accepted: session.accepted,
  });
});

// UI updates on state change
callSession.onStateChange((session) => {
  const isActive = session.state === "detected" || session.state === "active";

  if (isActive) {
    if (activeCallEl) activeCallEl.classList.remove("hidden");
    if (newCallSection) newCallSection.style.display = "none";
    if (activeCallStatus) activeCallStatus.textContent = session.accepted ? "Call in progress" : "Call detected";

    // Start timer updates
    if (!callTimerInterval) {
      callTimerInterval = setInterval(() => {
        const s = callSession.getState();
        if (activeCallTimer) activeCallTimer.textContent = s.durationFormatted;
      }, 1000);
    }
  } else {
    if (activeCallEl) activeCallEl.classList.add("hidden");
    if (newCallSection) newCallSection.style.display = "";

    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
    if (activeCallTimer) activeCallTimer.textContent = "0:00";
  }

  // Render history
  _renderCallHistory();
});

function _renderCallHistory() {
  if (!callsHistory) return;

  const items = callSession.getHistory();
  if (items.length === 0) {
    callsHistory.innerHTML = '<span class="calls-empty">No calls yet</span>';
    return;
  }

  callsHistory.innerHTML = items.map((item) => {
    const time = new Date(item.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const status = item.accepted ? "Accepted" : item.dismissed ? "Dismissed" : "Auto";
    const trigger = item.trigger === "manual" ? "Outgoing" : "Incoming";
    return `
      <div class="call-item" data-call-id="${item.callId}">
        <div class="call-icon ${item.trigger === "manual" ? "outgoing" : "incoming"}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </div>
        <div class="call-info">
          <span class="call-name">${trigger} - ${status}</span>
          <span class="call-meta">${time} - ${item.durationFormatted}</span>
        </div>
      </div>
    `;
  }).join("");

  // Attach click handlers to open transcription sidebar
  callsHistory.querySelectorAll(".call-item").forEach((el, index) => {
    el.addEventListener("click", () => {
      const callId = el.dataset.callId;
      log.info("Controller", "History call clicked", { callId });
      const historyItems = callSession.getHistory();
      _openTranscriptionSidebar(historyItems[index]);
    });
  });
}

function _openTranscriptionSidebar(callData, gatewaySessionId) {
  window.audioDriver.openTranscription(gatewaySessionId);
  // Send call object to the transcription window once it's ready
  const data = callData || callSession.getState().call;
  if (data) {
    // Small delay to let the window load
    setTimeout(() => {
      window.audioDriver.updateCallState({
        ...data,
        micSpeaking: false,
        callerSpeaking: false,
        userName,
      });
    }, 500);
  }
}

/**
 * Ensure audio capture (including mic) is running. If not, start it.
 */
async function _ensureCaptureRunning() {
  if (currentState.running && audioCapture.getAnalyser()) return;
  log.info("Controller", "Auto-starting capture for call");
  toggle.checked = true;
  await startWithDevice(selectedMicId);
}

/**
 * Start gateway streaming — create session, connect mic socket, begin recording.
 * Mic audio flows over a Unix domain socket (not IPC) for lower overhead.
 */
async function _startGatewayStreaming() {
  await _ensureCaptureRunning();

  const call = callSession.getState().call;
  if (!call) return null;

  let gatewaySessionId = null;
  try {
    const result = await window.audioDriver.gatewayStartSession(call);
    if (result.ok) {
      gatewaySessionId = result.sessionId;
      log.info("Controller", "Gateway session started", { sessionId: result.sessionId });
    } else {
      log.warn("Controller", "Gateway session failed", { error: result.error });
    }
  } catch (e) {
    log.warn("Controller", "Gateway session error", { error: e.message });
  }

  // Connect mic audio socket (bypasses IPC for audio data)
  try {
    const socketPath = await window.audioDriver.getMicSocketPath();
    if (socketPath) {
      micSocket.connect(socketPath);
      log.info("Controller", "Mic socket connected", { path: socketPath });
    } else {
      log.warn("Controller", "No mic socket path available");
    }
  } catch (e) {
    log.warn("Controller", "Mic socket connect error", { error: e.message });
  }

  // Wait for mic stream to be ready, then start recording
  const waitForMic = () => {
    if (audioCapture.getAnalyser()) {
      audioCapture.startRecording((buffer) => {
        micSocket.send(buffer);
      });
    } else {
      log.debug("Controller", "Waiting for mic stream...");
      setTimeout(waitForMic, 200);
    }
  };
  waitForMic();

  return gatewaySessionId;
}

/**
 * Stop gateway streaming — stop mic recording, disconnect socket, close session.
 */
function _stopGatewayStreaming() {
  audioCapture.stopRecording();
  micSocket.disconnect();
  window.audioDriver.gatewayStopSession();
  log.info("Controller", "Gateway streaming stopped");
}

/**
 * Push live call state (speaker, timer) to the transcription window.
 * Called from updateDetectionUI so it runs every frame.
 */
function _pushCallStateToTranscription(micSpeaking, callerSpeaking) {
  const session = callSession.getState();
  if (session.state === "idle") return;

  window.audioDriver.updateCallState({
    durationFormatted: session.durationFormatted,
    micSpeaking,
    callerSpeaking,
    userName,
    state: session.state,
    accepted: session.accepted,
  });
}

// ─── Auto-launch setting ────────────────────────────────────

const autoLaunchToggle = document.getElementById("auto-launch-toggle");

if (autoLaunchToggle) {
  (async () => {
    const enabled = await window.audioDriver.getAutoLaunch();
    autoLaunchToggle.checked = enabled;
  })();

  autoLaunchToggle.addEventListener("change", () => {
    window.audioDriver.setAutoLaunch(autoLaunchToggle.checked);
    log.info("Controller", "Auto-launch toggled", { enabled: autoLaunchToggle.checked });
  });
}

// ─── User identity (for VAD display) ────────────────────────

let userName = "";

// ─── Detection UI elements ──────────────────────────────────

const detectionBar = document.getElementById("detection-bar");
const noiseBar = document.getElementById("noise-bar");
const noiseLabel = document.getElementById("noise-label");
const feedbackBar = document.getElementById("feedback-bar");
const feedbackLabel = document.getElementById("feedback-label");
const statusDot = document.getElementById("audio-status-dot");
const statusText = document.getElementById("audio-status-text");

// ─── Detection rendering ────────────────────────────────────

let lastNoiseLevel = "low";

function updateDetectionUI() {
  const state = vad.getState();
  const feedback = feedbackDetection.getState();

  // Noise meter: map noise floor to a percentage (0–100)
  // noiseFloor is typically 0–0.1 range, scale up for visibility
  const noisePct = Math.min(100, Math.round(state.noiseFloor * 1000));
  if (noiseBar) noiseBar.style.width = noisePct + "%";

  if (state.noiseLevel !== lastNoiseLevel) {
    lastNoiseLevel = state.noiseLevel;
    if (noiseBar) {
      noiseBar.className = "meter-fill noise-" + state.noiseLevel;
    }
  }

  if (noiseLabel) {
    noiseLabel.textContent = state.isSpeaking ? "Speaking" : state.noiseLevel;
  }

  // Feedback meter: show intensity when detected
  if (feedbackBar) {
    feedbackBar.style.width = feedback.feedbackDetected ? "100%" : "0%";
  }
  if (feedbackLabel) {
    feedbackLabel.textContent = feedback.feedbackDetected
      ? (feedback.feedbackFrequency + " Hz")
      : "None";
  }

  // Update status dot + text based on VAD state (mic + speaker)
  const spk = speakerVad.getState();
  const micSpeaking = state.speaking;
  const callerSpeaking = spk.speaking;
  const displayName = userName || "You";

  if (statusDot && statusText) {
    if (state.fanNoise) {
      statusDot.className = "dot fan-noise";
      statusText.textContent = "Fan Noise";
    } else if (micSpeaking && callerSpeaking) {
      statusDot.className = "dot speaking";
      statusText.textContent = displayName + " + Caller";
    } else if (micSpeaking) {
      statusDot.className = "dot speaking";
      statusText.textContent = displayName + " Speaking";
    } else if (callerSpeaking) {
      statusDot.className = "dot caller-speaking";
      statusText.textContent = "Caller Speaking";
    } else {
      statusDot.className = "dot running";
      statusText.textContent = "Capturing";
    }
  }

  // Feed call session detector with both VAD states
  callSession.process(micSpeaking, callerSpeaking);

  // Push live state to transcription sidebar
  _pushCallStateToTranscription(micSpeaking, callerSpeaking);
}

// ─── State ───────────────────────────────────────────────────

let currentState = {
  running: false,
  message: "Off",
  micName: "",
  speakerName: "",
};

let selectedMicId = null;
let selectedSpeakerId = null;

// ─── Speaker levels from main process (daemon socket) ────────

window.audioDriver.onSpeakerLevel((data) => {
  const rms = typeof data === "number" ? data : data.rms;
  speakerMeter.update(rms);
  speakerVad.process(rms, data);
});

// ─── Wire controls to model ─────────────────────────────────

micControl.onMute((muted) => {
  audioCapture.setMicMuted(muted);
});

micControl.onVolume((value) => {
  audioCapture.setMicGain(value);
});

speakerControl.onMute(() => {
  window.audioDriver.speakerMuteToggle();
});

speakerControl.onVolumeDown(() => {
  window.audioDriver.speakerVolumeDown();
});

speakerControl.onVolumeUp(() => {
  window.audioDriver.speakerVolumeUp();
});

// Listen for volume state from main process (keyboard keys or UI)
window.audioDriver.onVolumeChanged((state) => {
  if (state && state.ok) {
    const pct = Math.round(state.volume * 100);
    speakerControl.setVolume(state.volume);
    speakerControl.setMuted(state.muted);
  }
});

// ─── Device population ──────────────────────────────────────

async function refreshDevices(activeMicId) {
  try {
    const { inputs, outputs } = await audioCapture.listDevices();
    populateDeviceSelect("mic-device", inputs, activeMicId || selectedMicId);
    populateDeviceSelect("speaker-device", outputs, selectedSpeakerId);
  } catch (e) {
    log.warn("Controller", "Failed to list devices", { error: e.message });
  }
}

// ─── Start/stop capture ──────────────────────────────────────

async function startWithDevice(micDeviceId) {
  // 1. Enable mirror FIRST so BlackHole receives system audio
  currentState = await window.audioDriver.startCapture();
  renderState(currentState);

  // 2. Now open mic stream (speaker comes from main process via daemon)
  vad.reset();
  speakerVad.reset();
  feedbackDetection.reset();

  const deviceInfo = await audioCapture.start((micLevel) => {
    micMeter.update(micLevel);

    // Feed VAD pipeline and feedback detector, then update UI
    vad.process(micLevel, audioCapture.getAnalyser());
    feedbackDetection.process(audioCapture.getAnalyser());
    updateDetectionUI();
  }, micDeviceId);

  currentState.micName = deviceInfo.micName;
  currentState.speakerName = deviceInfo.speakerName;
  renderState(currentState);
  updatePermissionNotice(currentState.permissions);

  // Show detection meters
  if (detectionBar) detectionBar.classList.remove("hidden");

  // Fetch initial speaker volume
  const volState = await window.audioDriver.speakerVolumeGet();
  if (volState && volState.ok) {
    speakerControl.setVolume(volState.volume);
    speakerControl.setMuted(volState.muted);
  }

  await refreshDevices(deviceInfo.micDeviceId);
}

async function stopAndReset() {
  audioCapture.stop();
  vad.reset();
  speakerVad.reset();
  feedbackDetection.reset();
  callSession.reset();
  micMeter.update(0);
  speakerMeter.update(0);

  // Hide detection meters
  if (detectionBar) detectionBar.classList.add("hidden");

  currentState = await window.audioDriver.stopCapture();
  renderState(currentState);
  updatePermissionNotice(null);
}

// ─── Toggle handler ──────────────────────────────────────────

// ─── Permission notice ─────────────────────────────────────

const permissionNotice = document.getElementById("permission-notice");
const permissionMessage = document.getElementById("permission-message");

function updatePermissionNotice(permissions) {
  if (!permissionNotice) return;

  if (!permissions) {
    permissionNotice.classList.add("hidden");
    return;
  }

  const issues = [];
  if (permissions.microphone && permissions.microphone !== "granted") {
    issues.push("Microphone");
  }
  if (permissions.accessibility === false) {
    issues.push("Accessibility");
  }

  if (issues.length > 0) {
    if (permissionMessage) {
      permissionMessage.textContent =
        issues.join(" and ") +
        " permission required. Grant access in System Settings \u2192 Privacy & Security, then restart the app.";
    }
    permissionNotice.classList.remove("hidden");
  } else {
    permissionNotice.classList.add("hidden");
  }
}

// ─── Toggle handler ──────────────────────────────────────

const toggle = document.getElementById("audio-enabled-toggle");

function setTransitioning(label) {
  if (toggle) toggle.disabled = true;
  const dot = document.getElementById("audio-status-dot");
  const text = document.getElementById("audio-status-text");
  if (dot) dot.className = "dot transitioning";
  if (text) text.textContent = label;
}

function clearTransitioning() {
  if (toggle) toggle.disabled = false;
}

if (toggle) {
  toggle.addEventListener("change", async () => {
    try {
      if (toggle.checked) {
        setTransitioning("Enabling\u2026");
        await startWithDevice(selectedMicId);
      } else {
        setTransitioning("Disabling\u2026");
        await stopAndReset();
      }
    } catch (e) {
      log.error("Controller", "Toggle failed", { error: e.message });
      console.error("Toggle error:", e);
      toggle.checked = !toggle.checked;
    } finally {
      clearTransitioning();
    }
  });
}

// ─── Device change handlers ──────────────────────────────────

onDeviceChange("mic-device", async (deviceId) => {
  selectedMicId = deviceId;

  // Change the macOS system input device
  const select = document.getElementById("mic-device");
  const selectedOption = select.options[select.selectedIndex];
  if (selectedOption) {
    const label = selectedOption.textContent;
    log.info("Controller", "Changing system input", { deviceId, label });
    const result = await window.audioDriver.setSystemInput(label);
    log.info("Controller", "System input changed", result);
  }

  // Also switch the mic capture stream if running
  if (currentState.running) {
    audioCapture.stop();
    try {
      await startWithDevice(deviceId);
    } catch (e) {
      log.error("Controller", "Failed to switch mic", { error: e.message });
      await stopAndReset();
    }
  }
});

onDeviceChange("speaker-device", async (deviceId) => {
  selectedSpeakerId = deviceId;

  // Get the label from the select element to pass the device name to macOS
  const select = document.getElementById("speaker-device");
  const selectedOption = select.options[select.selectedIndex];
  if (selectedOption) {
    const label = selectedOption.textContent;
    log.info("Controller", "Changing system output", { deviceId, label });
    const result = await window.audioDriver.setSystemOutput(label);
    log.info("Controller", "System output changed", result);
  }
});

// ─── Auto-start from main process ────────────────────────────

window.audioDriver.onAutoStart(async () => {
  log.info("Controller", "Auto-start received from main");
  if (!currentState.running) {
    if (toggle) toggle.checked = true;
    try {
      await startWithDevice(selectedMicId);
    } catch (e) {
      log.error("Controller", "Auto-start failed", { error: e.message });
      if (toggle) toggle.checked = false;
    }
  }
});

// ─── Auto-refresh device lists when devices change ───────────

navigator.mediaDevices.addEventListener("devicechange", () => {
  log.info("Controller", "Device list changed — refreshing");
  refreshDevices();
});

// ─── Initial state ───────────────────────────────────────────

(async () => {
  try {
    log.info("Controller", "Initializing");
    currentState = await window.audioDriver.getState();
    renderState(currentState);
    updatePermissionNotice(currentState.permissions);
    await refreshDevices();
    log.info("Controller", "Ready", currentState);
  } catch (e) {
    log.error("Controller", "Init failed", { error: e.message });
    currentState.message = "Error";
    renderState(currentState);
  }
})();

// ─── sulla-desktop auth init ─────────────────────────────────
// sulla-desktop handles auth — unlock all tabs immediately
document.querySelectorAll(".sidebar-btn[data-requires-auth]").forEach((btn) => {
  btn.classList.remove("locked");
});
