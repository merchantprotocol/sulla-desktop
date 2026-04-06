/**
 * Bridge — maps window.audioDriver API to sulla-desktop IPC channels.
 *
 * The standalone audio-driver renderer uses window.audioDriver (set by preload.js).
 * This bridge recreates the same API using sulla-desktop's IPC channel names,
 * so the renderer controller and models work without modification.
 */

const { ipcRenderer } = require("electron");

window.__GHOST_AGENT_URL__ = "https://app.dataripple.com";

window.audioDriver = {
  getState: () => ipcRenderer.invoke("audio-driver:get-state"),
  startCapture: () => ipcRenderer.invoke("audio-driver:start-capture"),
  stopCapture: () => ipcRenderer.invoke("audio-driver:stop-capture"),
  setDeviceNames: (mic, speaker) => ipcRenderer.invoke("audio-driver:set-device-names", mic, speaker),
  setSystemOutput: (deviceName) => ipcRenderer.invoke("audio-driver:set-system-output", deviceName),
  setSystemInput: (deviceName) => ipcRenderer.invoke("audio-driver:set-system-input", deviceName),

  getAutoLaunch: () => ipcRenderer.invoke("audio-driver:get-auto-launch"),
  setAutoLaunch: (enabled) => ipcRenderer.invoke("audio-driver:set-auto-launch", enabled),

  openTranscription: (callId) => ipcRenderer.invoke("audio-driver:open-transcription", callId),
  minimizeTranscription: () => ipcRenderer.invoke("audio-driver:minimize-transcription"),
  restoreTranscription: () => ipcRenderer.invoke("audio-driver:restore-transcription"),
  endCallFromTranscription: () => ipcRenderer.send("audio-driver:end-call-from-transcription"),
  showCallNotification: () => ipcRenderer.invoke("audio-driver:show-call-notification"),
  updateCallState: (state) => ipcRenderer.send("audio-driver:update-call-state", state),

  // Gateway streaming
  gatewayStartSession: (callData) => ipcRenderer.invoke("audio-driver:gateway-start", callData),
  gatewayStopSession: () => ipcRenderer.invoke("audio-driver:gateway-stop"),
  getMicSocketPath: () => ipcRenderer.invoke("audio-driver:get-mic-socket-path"),
  onGatewayTranscript: (callback) => ipcRenderer.on("gateway-transcript", (_e, data) => callback(data)),
  onGatewayStatus: (callback) => ipcRenderer.on("gateway-status", (_e, status) => callback(status)),

  onCallAccepted: (callback) => ipcRenderer.on("audio-driver:call-accepted", () => callback()),
  onCallDismissed: (callback) => ipcRenderer.on("audio-driver:call-dismissed", () => callback()),
  onEndCall: (callback) => ipcRenderer.on("audio-driver:end-call", () => callback()),

  // Auth — sulla-desktop handles this separately, but stub for compatibility
  login: () => Promise.resolve({ ok: true, loggedIn: true }),
  logout: () => Promise.resolve({ ok: true }),
  getSession: () => ipcRenderer.invoke("audio-driver:get-session"),
  setActiveTeam: () => Promise.resolve({}),

  speakerVolumeUp: () => ipcRenderer.invoke("audio-driver:speaker-volume-up"),
  speakerVolumeDown: () => ipcRenderer.invoke("audio-driver:speaker-volume-down"),
  speakerMuteToggle: () => ipcRenderer.invoke("audio-driver:speaker-mute-toggle"),
  speakerVolumeGet: () => ipcRenderer.invoke("audio-driver:speaker-volume-get"),

  onAutoStart: (callback) => ipcRenderer.on("audio-driver:auto-start", () => callback()),
  onSpeakerLevel: (callback) => ipcRenderer.on("audio-driver:speaker-level", (_e, level) => callback(level)),
  onSpeakerDeviceChanged: (callback) => ipcRenderer.on("audio-driver:speaker-device-changed", (_e, name) => callback(name)),
  onVolumeChanged: (callback) => ipcRenderer.on("audio-driver:volume-changed", (_e, state) => callback(state)),

  // Broadcast mic VAD state to main process for relay to all windows
  broadcastMicVad: (data) => ipcRenderer.send("audio-driver:mic-vad-update", data),

  log: {
    error: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "error", tag, msg, data),
    warn: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "warn", tag, msg, data),
    info: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "info", tag, msg, data),
    debug: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "debug", tag, msg, data),
  },
};
