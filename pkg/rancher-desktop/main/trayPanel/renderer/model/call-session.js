/**
 * Model — call/meeting session lifecycle.
 *
 * Tracks call sessions from detection through to end. Sessions are
 * tracked regardless of whether the user accepts or dismisses the
 * notification — accept/dismiss only controls UI engagement, not
 * session tracking.
 *
 * Detection can be:
 *   - Manual: user clicks "New Call" → immediate active session
 *   - Automatic: speaker VAD shows sustained speech → detected
 *
 * States:
 *   idle     → no active session
 *   detected → speech detected, notification pending, timer running
 *   active   → user accepted (or manual start), timer running
 *   ended    → silence sustained, session complete, ready for next
 *
 * A new notification only fires after the current session fully ends.
 *
 * No DOM access, no view logic — pure lifecycle tracking.
 */

// ─── Configuration ──────────────────────────────────────────────

const SPEAKER_TRIGGER_MS = 3000;     // Speaker must be active this long to auto-detect
const MIC_CONFIRM_WINDOW_MS = 10000; // Mic must be active within this window of speaker
const END_SILENCE_MS = 60000;        // Both channels silent this long = call ended
const MIN_SESSION_MS = 5000;         // Minimum session duration before we allow ending

// ─── State ──────────────────────────────────────────────────────

let state = "idle";  // idle | detected | active | ended
let sessionId = 0;
let startTime = null;
let endTime = null;
let detectedTime = null;
let accepted = false;
let dismissed = false;

// ─── Call object ────────────────────────────────────────────────
// The call is the data record for this session. User/org info is
// set via setUser() from the controller. callId comes from the
// backend on incoming calls (future), or is generated locally.

let call = null;

// User/org context — persists across sessions, set once on login
let userContext = {
  userId: null,
  userName: null,
  userEmail: null,
  organizationId: null,
  organizationName: null,
};

function _newCall(trigger, now) {
  return {
    callId: null,                       // Set by backend or generated locally
    userId: userContext.userId,
    userName: userContext.userName,
    userEmail: userContext.userEmail,
    organizationId: userContext.organizationId,
    organizationName: userContext.organizationName,
    trigger,                            // "manual" | "auto" | "incoming" (future)
    recording: true,
    startTime: now,
    endTime: null,
    duration: 0,
    durationFormatted: "0:00",
    accepted: false,
    dismissed: false,
  };
}

// Auto-detection tracking
let speakerActiveStart = null;  // When speaker started sustained speech
let micActiveInWindow = false;  // Mic was active during confirm window
let lastSpeakerSpeaking = false;
let lastMicSpeaking = false;
let silenceStart = null;        // When both channels went silent

// Session history
const history = [];
const MAX_HISTORY = 50;

// Callbacks
let onDetected = null;   // Fires when auto-detection triggers
let onEnded = null;       // Fires when session ends
let onChange = null;       // Fires on any state change

// ─── Public API ─────────────────────────────────────────────────

/**
 * Process VAD states each frame. Call from the render loop.
 *
 * @param {boolean} micSpeaking — mic VAD speaking state
 * @param {boolean} speakerSpeaking — speaker VAD speaking state
 */
function process(micSpeaking, speakerSpeaking) {
  const now = Date.now();

  // Track when speaker starts/stops sustained speech
  if (speakerSpeaking && !lastSpeakerSpeaking) {
    speakerActiveStart = now;
  }
  if (!speakerSpeaking) {
    speakerActiveStart = null;
  }

  // Track mic activity within the confirmation window
  if (micSpeaking) {
    micActiveInWindow = true;
  }

  lastSpeakerSpeaking = speakerSpeaking;
  lastMicSpeaking = micSpeaking;

  // ── Auto-detection (only in idle state) ───────────────────

  if (state === "idle") {
    if (speakerActiveStart && (now - speakerActiveStart) >= SPEAKER_TRIGGER_MS) {
      // Speaker has been active long enough — trigger detection
      _startSession("auto", now);
    }
    return;
  }

  // ── Silence tracking (detected or active states) ──────────

  if (state === "detected" || state === "active") {
    const bothSilent = !micSpeaking && !speakerSpeaking;

    if (bothSilent) {
      if (!silenceStart) silenceStart = now;

      const elapsed = now - startTime;
      const silenceDuration = now - silenceStart;

      if (elapsed >= MIN_SESSION_MS && silenceDuration >= END_SILENCE_MS) {
        _endSession(now);
      }
    } else {
      silenceStart = null;
    }
  }
}

/**
 * Set the logged-in user and organization.
 * Call this when the user logs in or switches teams.
 *
 * @param {{ userId, userName, userEmail, organizationId, organizationName }} info
 */
function setUser(info) {
  userContext.userId = info.userId || null;
  userContext.userName = info.userName || null;
  userContext.userEmail = info.userEmail || null;
  userContext.organizationId = info.organizationId || null;
  userContext.organizationName = info.organizationName || null;
}

/**
 * Set the call ID (from backend on incoming calls — future use).
 *
 * @param {string} callId
 */
function setCallId(callId) {
  if (call) call.callId = callId;
}

/**
 * Manual start — user clicked "New Call".
 */
function startManual() {
  if (state !== "idle") return getState();
  _startSession("manual", Date.now());
  accepted = true;  // Manual start = implicitly accepted
  _fireChange();
  return getState();
}

/**
 * User accepted the call notification.
 */
function accept() {
  if (state !== "detected") return;
  accepted = true;
  state = "active";
  if (call) call.accepted = true;
  _fireChange();
}

/**
 * User dismissed the call notification.
 * Session continues tracking — just no active UI.
 */
function dismiss() {
  if (state !== "detected") return;
  dismissed = true;
  if (call) call.dismissed = true;
  _fireChange();
}

/**
 * Force end the current session (user clicked end call).
 */
function endManual() {
  if (state === "idle" || state === "ended") return;
  _endSession(Date.now());
}

/**
 * Get current session state.
 */
function getState() {
  const now = Date.now();
  const duration = startTime ? (endTime || now) - startTime : 0;
  const formatted = _formatDuration(duration);

  // Keep the call object's duration in sync
  if (call) {
    call.duration = duration;
    call.durationFormatted = formatted;
    call.endTime = endTime;
  }

  return {
    state,
    sessionId,
    startTime,
    endTime,
    detectedTime,
    duration,
    accepted,
    dismissed,
    durationFormatted: formatted,
    call: call ? { ...call } : null,
  };
}

/**
 * Get session history (most recent first).
 */
function getHistory() {
  return history.slice().reverse();
}

/**
 * Register callbacks.
 */
function onCallDetected(cb) { onDetected = cb; }
function onCallEnded(cb) { onEnded = cb; }
function onStateChange(cb) { onChange = cb; }

/**
 * Reset to idle (e.g., when capture stops).
 */
function reset() {
  state = "idle";
  startTime = null;
  endTime = null;
  detectedTime = null;
  accepted = false;
  dismissed = false;
  speakerActiveStart = null;
  micActiveInWindow = false;
  silenceStart = null;
  lastSpeakerSpeaking = false;
  lastMicSpeaking = false;
}

// ─── Internal ───────────────────────────────────────────────────

function _startSession(trigger, now) {
  sessionId++;
  state = trigger === "manual" ? "active" : "detected";
  startTime = now;
  endTime = null;
  detectedTime = now;
  accepted = trigger === "manual";
  dismissed = false;
  silenceStart = null;

  // Create the call object for this session
  call = _newCall(trigger, now);
  call.callId = "local_" + sessionId + "_" + now;
  call.accepted = trigger === "manual";

  if (trigger === "auto" && onDetected) {
    onDetected(getState());
  }
  _fireChange();
}

function _endSession(now) {
  endTime = now;
  const session = getState();
  state = "idle";

  // Finalize and save the call object to history
  if (call) {
    call.recording = false;
    call.endTime = endTime;
    call.duration = session.duration;
    call.durationFormatted = session.durationFormatted;
    history.push({ ...call });
    if (history.length > MAX_HISTORY) history.shift();
  }

  // Reset session state for next call
  speakerActiveStart = null;
  micActiveInWindow = false;
  silenceStart = null;
  startTime = null;
  endTime = null;
  accepted = false;
  dismissed = false;
  call = null;

  if (onEnded) onEnded(session);
  _fireChange();
}

function _fireChange() {
  if (onChange) onChange(getState());
}

function _formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min + ":" + (sec < 10 ? "0" : "") + sec;
}

module.exports = {
  process,
  setUser,
  setCallId,
  startManual,
  accept,
  dismiss,
  endManual,
  getState,
  getHistory,
  onCallDetected,
  onCallEnded,
  onStateChange,
  reset,
};
