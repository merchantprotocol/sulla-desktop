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
];
