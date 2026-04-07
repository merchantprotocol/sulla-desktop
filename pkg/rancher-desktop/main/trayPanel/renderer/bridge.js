/**
 * @file bridge.js — IPC Bridge for the Audio Driver renderer API
 *
 * # What this file does
 *
 * Sets `window.audioDriver` — the **single entry point** through which all
 * renderer-side code interacts with the audio driver system. Every method on
 * this object maps to an `audio-driver:*` IPC channel handled in
 * `audio-driver/init.ts` on the main process side.
 *
 * # Why all renderer audio access should go through window.audioDriver
 *
 * `window.audioDriver` is the canonical renderer-side API for:
 * - Starting/stopping mic and speaker capture
 * - Controlling gain, mute, and device selection
 * - Opening/closing gateway transcription sessions
 * - Receiving real-time transcript events, speaker levels, and VAD state
 * - Controlling speaker volume (routed to the physical device via CoreAudio)
 * - Managing whisper.cpp (local STT) installation and model downloads
 *
 * Any renderer code that needs audio capabilities should call methods on
 * `window.audioDriver` rather than using `ipcRenderer` directly. This
 * ensures consistent channel naming, proper event registration, and
 * forward compatibility if the IPC contract changes.
 *
 * # Origin
 *
 * The standalone audio-driver Electron app had its own `preload.js` that set
 * `window.audioDriver`. When the audio driver was integrated into sulla-desktop
 * (which uses a different preload), this bridge was created to provide the
 * identical API shape so that all renderer models and controllers work without
 * modification.
 *
 * # Available methods
 *
 * | Method                    | IPC channel                            | Direction       |
 * |---------------------------|----------------------------------------|-----------------|
 * | getState()                | audio-driver:get-state                 | invoke          |
 * | setDeviceNames(mic, spk)  | audio-driver:set-device-names          | invoke          |
 * | setSystemOutput(name)     | audio-driver:set-system-output         | invoke          |
 * | setSystemInput(name)      | audio-driver:set-system-input          | invoke          |
 * | gatewayStartSession(data) | audio-driver:gateway-start             | invoke          |
 * | gatewayStopSession()      | audio-driver:gateway-stop              | invoke          |
 * | getMicSocketPath()        | audio-driver:get-mic-socket-path       | invoke          |
 * | onGatewayTranscript(cb)   | gateway-transcript                     | on (listener)   |
 * | onGatewayStatus(cb)       | gateway-status                         | on (listener)   |
 * | onStartMic(cb)            | audio-driver:renderer-start-mic        | on (listener)   |
 * | onStopMic(cb)             | audio-driver:renderer-stop-mic         | on (listener)   |
 * | ackMicStarted(info)       | audio-driver:mic-started               | send            |
 * | ackMicStopped()           | audio-driver:mic-stopped               | send            |
 * | onSpeakerLevel(cb)        | audio-driver:speaker-level             | on (listener)   |
 * | broadcastMicVad(data)     | audio-driver:mic-vad-update            | send            |
 * | speakerVolumeUp()         | audio-driver:speaker-volume-up         | invoke          |
 * | speakerVolumeDown()       | audio-driver:speaker-volume-down       | invoke          |
 * | speakerMuteToggle()       | audio-driver:speaker-mute-toggle       | invoke          |
 * | speakerVolumeGet()        | audio-driver:speaker-volume-get        | invoke          |
 * | log.*                     | audio-driver:log                       | send            |
 */

const { ipcRenderer } = require("electron");

window.__GHOST_AGENT_URL__ = "https://app.dataripple.com";

window.audioDriver = {
  getState: () => ipcRenderer.invoke("audio-driver:get-state"),
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

  // Worker commands from MicrophoneDriverController / SpeakerDriverController (main process)
  onStartMic: (callback) => ipcRenderer.on("audio-driver:renderer-start-mic", (_e, opts) => callback(opts)),
  onStopMic: (callback) => ipcRenderer.on("audio-driver:renderer-stop-mic", () => callback()),
  ackMicStarted: (deviceInfo) => ipcRenderer.send("audio-driver:mic-started", deviceInfo),
  ackMicStopped: () => ipcRenderer.send("audio-driver:mic-stopped"),


  // Broadcast mic VAD state to main process for relay to holder windows
  broadcastMicVad: (data) => ipcRenderer.send("audio-driver:mic-vad-update", data),

  // Send raw PCM chunk (s16le, 16kHz, mono) to main process
  sendMicPcm: (buffer) => ipcRenderer.send("audio-driver:mic-pcm", buffer),

  // Report mic errors (e.g. getUserMedia permission denied) to main process
  reportMicError: (data) => ipcRenderer.send("audio-driver:mic-error", data),

  log: {
    error: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "error", tag, msg, data),
    warn: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "warn", tag, msg, data),
    info: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "info", tag, msg, data),
    debug: (tag, msg, data) => ipcRenderer.send("audio-driver:log", "debug", tag, msg, data),
  },
};
