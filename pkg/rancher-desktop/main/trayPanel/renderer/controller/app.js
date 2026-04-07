/**
 * Controller — dumb mic-capture worker + call session management.
 *
 * The MicrophoneDriverController / SpeakerDriverController (main process) owns all lifecycle decisions.
 * This renderer only:
 *   1. Starts/stops getUserMedia when commanded via IPC
 *   2. Runs VAD + feedback detection and broadcasts results
 *   3. Manages call sessions and gateway streaming
 *
 * Delegates to:
 *   model/audio-capture.js — mic capture, gain, mute
 *   model/vad.js           — voice activity detection
 *   model/speaker-vad.js   — speaker voice detection
 *   model/feedback-detection.js — audio feedback detection
 *   model/mic-socket.js    — Unix socket for mic audio chunks
 *   model/call-session.js  — call detection and state
 */

const audioCapture = require("../model/audio-capture");
const micSocket = require("../model/mic-socket");
const vad = require("../model/vad");
const feedbackDetection = require("../model/feedback-detection");
const callSession = require("../model/call-session");

const log = window.audioDriver.log;

// ─── User identity (for VAD display) ────────────────────────

let userName = "";

// ─── Mic level callback (shared by start handler + gateway) ─

function onMicLevel(micLevel) {
  const vadState = vad.process(micLevel, audioCapture.getAnalyser());
  feedbackDetection.process(audioCapture.getAnalyser());

  // Process call session detection (speaker state not available here)
  callSession.process(vadState.speaking, false);

  // Push live state to transcription sidebar
  _pushCallStateToTranscription(vadState.speaking, false);

  // Broadcast mic VAD to all windows (chat, secretary, etc.)
  window.audioDriver.broadcastMicVad({
    speaking: vadState.speaking,
    level: micLevel,
    fanNoise: vadState.fanNoise,
    noiseFloor: vadState.amplitude ? vadState.amplitude.noiseFloor : 0,
    zcr: vadState.zeroCrossing ? vadState.zeroCrossing.smoothedZcr : 0,
    variance: vadState.temporalVariance ? vadState.temporalVariance.variance : 0,
    pitch: vadState.pitch ? vadState.pitch.pitch : null,
    centroid: vadState.spectral ? vadState.spectral.centroid : 0,
  });
}

// ─── Mic worker: start/stop on command from main process ────

window.audioDriver.onStartMic(async (opts) => {
  log.info("Controller", ">>> renderer-start-mic received", opts);
  try {
    vad.reset();
    feedbackDetection.reset();
    log.info("Controller", "VAD + feedback detection reset, calling audioCapture.start()");

    const deviceInfo = await audioCapture.start(onMicLevel, opts?.deviceId);
    log.info("Controller", "audioCapture.start() succeeded", {
      micName: deviceInfo?.micName,
      speakerName: deviceInfo?.speakerName,
      micDeviceId: deviceInfo?.micDeviceId,
    });
    log.info("Controller", "Sending ackMicStarted to main process");
    window.audioDriver.ackMicStarted(deviceInfo);
  } catch (e) {
    log.error("Controller", "audioCapture.start() FAILED", { error: e.message, stack: e.stack });
    window.audioDriver.ackMicStarted(null);
  }
});

window.audioDriver.onStopMic(() => {
  log.info("Controller", ">>> renderer-stop-mic received");
  audioCapture.stopRecording();
  log.info("Controller", "MediaRecorder stopped");
  audioCapture.stop();
  log.info("Controller", "audioCapture stopped (getUserMedia killed)");
  micSocket.disconnect();
  log.info("Controller", "micSocket disconnected");
  vad.reset();
  feedbackDetection.reset();
  log.info("Controller", "VAD + feedback detection reset, sending ackMicStopped");
  window.audioDriver.ackMicStopped();
});

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
  const data = callData || callSession.getState().call;
  if (data) {
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
 * Push live call state (speaker, timer) to the transcription window.
 * Called from onMicLevel so it runs every frame when mic is active.
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

/**
 * Start gateway streaming — connect mic socket, begin recording.
 * The mic must already be running (commanded by MicrophoneDriverController / SpeakerDriverController).
 */
async function _startGatewayStreaming() {
  // Ensure mic is running — if not, it will be started by the controller
  // when the caller (chat, secretary) invokes startMic() before this.
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

// ─── Initial state ──────────────────────────────────────────

(async () => {
  try {
    log.info("Controller", "Initializing (dumb worker mode)");
    const state = await window.audioDriver.getState();
    log.info("Controller", "Ready", state);
  } catch (e) {
    log.error("Controller", "Init failed", { error: e.message });
  }
})();

// ─── sulla-desktop auth init ────────────────────────────────
document.querySelectorAll(".sidebar-btn[data-requires-auth]").forEach((btn) => {
  btn.classList.remove("locked");
});
