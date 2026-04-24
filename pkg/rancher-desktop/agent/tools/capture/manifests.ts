import type { ToolManifest } from '../registry';

/**
 * Capture Studio tools — teleprompter, microphone, desktop-audio (speaker)
 * capture, screen/window enumeration, and screenshots. All dispatch into
 * main-process singletons (MicrophoneDriverController, SpeakerDriverController,
 * teleprompterWindow exports) or Electron's `desktopCapturer`, so the tools
 * run headless — the Capture Studio tab does NOT have to be open.
 *
 * Recorder + camera/screen stream acquisition live in the renderer
 * (MediaRecorder / getUserMedia) and require a renderer command bus; those
 * are intentionally out of scope for this first cut.
 */
export const captureToolManifests: ToolManifest[] = [
  // ── Teleprompter ────────────────────────────────────────────────

  {
    name:           'teleprompter_open',
    description:    'Open the floating teleprompter window (transparent, always-on-top, positioned near the webcam at top-center of the active display). Safe to call when it is already open.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['create'],
    loader:         () => import('./teleprompter_open'),
  },
  {
    name:           'teleprompter_close',
    description:    'Close the floating teleprompter window. No-op if it is already closed.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['delete'],
    loader:         () => import('./teleprompter_close'),
  },
  {
    name:           'teleprompter_status',
    description:    'Return whether the floating teleprompter window is currently open.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./teleprompter_status'),
  },
  {
    name:        'teleprompter_script',
    description: 'Push script text to the teleprompter. Splits on whitespace into words so the prompter can highlight the current word. Auto-opens the window if closed. Optionally sets the starting word index.',
    category:    'capture',
    schemaDef:   {
      text:         { type: 'string', description: 'Full script text — will be split on whitespace.' },
      currentIndex: { type: 'number', optional: true, description: 'Word index to start the highlight at (default 0).' },
    },
    operationTypes: ['update'],
    loader:         () => import('./teleprompter_script'),
  },
  {
    name:        'teleprompter_style',
    description: 'Update the teleprompter visual style (font size and/or highlight color). Requires the teleprompter to be open.',
    category:    'capture',
    schemaDef:   {
      fontSize:       { type: 'number', optional: true, description: 'Pixel size 10–120.' },
      highlightColor: { type: 'string', optional: true, description: 'CSS color string for the current-word highlight.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./teleprompter_style'),
  },

  // ── Microphone ─────────────────────────────────────────────────

  {
    name:        'mic_start',
    description: 'Start the microphone capture driver. On macOS, proactively requests microphone permission. Ref-counted — other services keeping it open will survive capture/mic_stop.',
    category:    'capture',
    schemaDef:   {
      formats: { type: 'array', optional: true, description: 'Optional output formats (e.g. ["webm-opus","pcm-s16le"]). Defaults to the driver\'s default set.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./mic_start'),
  },
  {
    name:           'mic_stop',
    description:    'Release this agent\'s hold on the microphone capture driver. Capture only stops fully when every service has released.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['delete'],
    loader:         () => import('./mic_stop'),
  },

  // ── Speaker (desktop audio loopback) ───────────────────────────

  {
    name:           'speaker_start',
    description:    'Start capturing the system\'s desktop audio output (speaker loopback). Ref-counted like mic_start.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['create'],
    loader:         () => import('./speaker_start'),
  },
  {
    name:           'speaker_stop',
    description:    'Release this agent\'s hold on the speaker-loopback capture driver.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['delete'],
    loader:         () => import('./speaker_stop'),
  },
  {
    name:           'audio_state',
    description:    'Report whether mic and speaker capture are currently running and which devices they\'re bound to.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./audio_state'),
  },

  // ── Screens / screenshots ──────────────────────────────────────

  {
    name:        'list_screens',
    description: 'Enumerate capturable displays and/or application windows via Electron\'s desktopCapturer. Returns { id, name } pairs the agent can pass to capture/screenshot.',
    category:    'capture',
    schemaDef:   {
      kind: { type: 'enum', optional: true, enum: ['screen', 'window', 'all'], default: 'all', description: 'Filter by source kind.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_screens'),
  },
  {
    name:        'screenshot',
    description: 'Take a full-resolution PNG screenshot of a screen or window and save it to ~/sulla/captures/screenshots/YYYY-MM-DD/. Omit sourceId to capture the primary display. Returns the absolute file path — use Read on it to inspect visually.',
    category:    'capture',
    schemaDef:   {
      sourceId: { type: 'string', optional: true, description: 'desktopCapturer source id from capture/list_screens (e.g. "screen:0:0" or "window:…"). Omit for primary display.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./screenshot'),
  },

  // ── Recorder (Phase 2 — requires CaptureStudio renderer) ───────

  {
    name:        'recorder_start',
    description: 'Start a recording session. Auto-opens Capture Studio and — when the streams aren\'t already acquired — auto-acquires whatever sources you ask for. Pass `screen: true` for the primary display, `screen: "source-id"` for a specific display/window (from list_screens), `camera: true` / `camera: "deviceId"`, and/or `mic: true` / `speaker: true`. Omit everything to record whatever sources the user already picked in the Capture Studio UI.',
    category:    'capture',
    schemaDef:   {
      screen:  { type: 'string',  optional: true, description: 'Pass "auto" for the primary display, or a desktopCapturer source id (see capture/list_screens).' },
      camera:  { type: 'string',  optional: true, description: 'Pass "auto" for the first camera, or a deviceId (see capture/camera_list).' },
      mic:     { type: 'boolean', optional: true, description: 'Start mic capture before recording (ref-counted).' },
      speaker: { type: 'boolean', optional: true, description: 'Start speaker-loopback capture before recording.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./recorder_start'),
  },
  {
    name:           'recorder_stop',
    description:    'Stop the active recording session. Writes manifest.json to the session directory. Returns the session path so you can Read the manifest or the output files.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['update'],
    loader:         () => import('./recorder_stop'),
  },
  {
    name:           'recorder_status',
    description:    'Report whether a recording is active, along with elapsed seconds, bytes written, current session directory, and any last error. Does NOT open Capture Studio just to answer this query — returns "idle" when Capture Studio isn\'t running.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./recorder_status'),
  },

  // ── Camera + screen streams (Phase 2) ─────────────────────────

  {
    name:           'camera_list',
    description:    'Enumerate video input devices (webcams, capture cards) visible to the Capture Studio renderer. Returns { deviceId, label } pairs.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./camera_list'),
  },
  {
    name:        'camera_set',
    description: 'Acquire a camera stream in Capture Studio. Without deviceId, uses the first available camera. Optionally set quality at the same time (480p | 720p | 1080p | 4k).',
    category:    'capture',
    schemaDef:   {
      deviceId: { type: 'string', optional: true, description: 'deviceId from capture/camera_list.' },
      quality:  { type: 'enum', optional: true, enum: ['auto', '480p', '720p', '1080p', '4k'], description: 'Recording quality preset.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./camera_set'),
  },
  {
    name:           'camera_release',
    description:    'Stop and release the current camera stream in Capture Studio.',
    category:       'capture',
    schemaDef:      {},
    operationTypes: ['delete'],
    loader:         () => import('./camera_release'),
  },
  {
    name:        'screen_set',
    description: 'Acquire a screen/window capture stream in Capture Studio by sourceId (from capture/list_screens). This is what the agent calls when it wants the recorder to include that display.',
    category:    'capture',
    schemaDef:   {
      sourceId: { type: 'string', description: 'desktopCapturer source id from capture/list_screens.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./screen_set'),
  },
  {
    name:        'quality_set',
    description: 'Set the recording quality preset for either the screen or camera stream (480p | 720p | 1080p | 4k | auto). Affects bitrate on the next recorder_start.',
    category:    'capture',
    schemaDef:   {
      target: { type: 'enum', enum: ['screen', 'camera'], description: 'Which stream to configure.' },
      preset: { type: 'enum', enum: ['auto', '480p', '720p', '1080p', '4k'], description: 'Quality preset.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./quality_set'),
  },
];
