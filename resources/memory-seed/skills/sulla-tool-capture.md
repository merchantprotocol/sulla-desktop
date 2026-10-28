---
slug: sulla-tool-capture
label: Use the Sulla Capture tools
trigger_when: When you need to use Sulla Capture operations.
trigger_actions: [capture, capture tools]
trigger_phrases: [capture, capture]
scope: [tool-capture]
---

**When:** When you need to use Sulla Capture operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# capture tools

Capture Studio control — teleprompter (open/close/script/style), microphone + speaker loopback lifecycle, screen/camera enumeration, screenshots, recorder start/stop/status with auto-acquire.

## audio_state

Report whether mic and speaker capture are currently running and which devices they're bound to.

**Parameters**

None.

**Example**

```bash
sulla capture/audio_state '{}'
```

## camera_list

Enumerate video input devices (webcams, capture cards) visible to the Capture Studio renderer. Returns { deviceId, label } pairs.

**Parameters**

None.

**Example**

```bash
sulla capture/camera_list '{}'
```

## camera_release

Stop and release the current camera stream in Capture Studio.

**Parameters**

None.

**Example**

```bash
sulla capture/camera_release '{}'
```

## camera_set

Acquire a camera stream in Capture Studio. Without deviceId, uses the first available camera.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `deviceId` | string | Optional |
| `quality` | enum: auto\|480p\|720p\|1080p\|4k | Optional |

**Example**

```bash
sulla capture/camera_set '{}'
```

## list_screens

Enumerate capturable displays and/or application windows via Electron's desktopCapturer. Returns { id, name } pairs the agent can pass to capture/screenshot.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | enum: screen\|window\|all | Optional |

**Example**

```bash
sulla capture/list_screens '{}'
```

## mic_start

Start the microphone capture driver. On macOS, proactively requests microphone permission.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `formats` | array | Optional |

**Example**

```bash
sulla capture/mic_start '{}'
```

## mic_stop

Release this agent's hold on the microphone capture driver. Capture only stops fully when every service has released.

**Parameters**

None.

**Example**

```bash
sulla capture/mic_stop '{}'
```

## quality_set

Set the recording quality preset for either the screen or camera stream (480p | 720p | 1080p | 4k | auto). Affects bitrate on the next recorder_start.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `target` | enum: screen\|camera | Required |
| `preset` | enum: auto\|480p\|720p\|1080p\|4k | Required |

**Example**

```bash
sulla capture/quality_set '{"target":"<target>","preset":"<preset>"}'
```

## recorder_start

Start a recording session. Auto-opens Capture Studio and — when the streams aren't already acquired — auto-acquires whatever sources you ask for.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `screen` | string | Optional |
| `camera` | string | Optional |
| `mic` | boolean | Optional |
| `speaker` | boolean | Optional |

**Example**

```bash
sulla capture/recorder_start '{}'
```

## recorder_status

Report whether a recording is active, along with elapsed seconds, bytes written, current session directory, and any last error. Does NOT open Capture Studio just to answer this query — returns "idle" when Capture Studio isn't running.

**Parameters**

None.

**Example**

```bash
sulla capture/recorder_status '{}'
```

## recorder_stop

Stop the active recording session. Writes manifest.json to the session directory.

**Parameters**

None.

**Example**

```bash
sulla capture/recorder_stop '{}'
```

## screen_set

Acquire a screen/window capture stream in Capture Studio by sourceId (from capture/list_screens). This is what the agent calls when it wants the recorder to include that display.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `sourceId` | string | Required |

**Example**

```bash
sulla capture/screen_set '{"sourceId":"<sourceId>"}'
```

## speaker_start

Prepare system-audio capture using Electron native loopback (ScreenCaptureKit on macOS 13+), with BlackHole only as a fallback. Auto-opens Capture Studio.

**Parameters**

None.

**Example**

```bash
sulla capture/speaker_start '{}'
```

## speaker_stop

Release Capture Studio's native or fallback speaker-loopback source.

**Parameters**

None.

**Example**

```bash
sulla capture/speaker_stop '{}'
```

## teleprompter_close

Close the floating teleprompter window. No-op if it is already closed.

**Parameters**

None.

**Example**

```bash
sulla capture/teleprompter_close '{}'
```

## teleprompter_open

Open the floating teleprompter window (transparent, always-on-top, positioned near the webcam at top-center of the active display). Safe to call when it is already open.

**Parameters**

None.

**Example**

```bash
sulla capture/teleprompter_open '{}'
```

## teleprompter_script

Push script text to the teleprompter. Splits on whitespace into words so the prompter can highlight the current word.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `text` | string | Required |
| `currentIndex` | number | Optional |

**Example**

```bash
sulla capture/teleprompter_script '{"text":"<text>"}'
```

## teleprompter_status

Return whether the floating teleprompter window is currently open.

**Parameters**

None.

**Example**

```bash
sulla capture/teleprompter_status '{}'
```

## teleprompter_style

Update the teleprompter visual style (font size and/or highlight color). Requires the teleprompter to be open.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `fontSize` | number | Optional |
| `highlightColor` | string | Optional |

**Example**

```bash
sulla capture/teleprompter_style '{}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
