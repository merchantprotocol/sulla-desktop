# Computer Use Agent — Desktop Automation via Grid-Assisted Screenshots

## Overview

Give Sulla's agent full computer use capabilities — mouse movement, clicking, typing, and scrolling — on the host macOS desktop. The agent observes the screen through screenshots annotated with a coordinate grid overlay, decides what action to take, and executes that action through native macOS input APIs. No browser automation layer (Playwright) is needed; this is entirely OS-native.

This mirrors Anthropic's computer use paradigm (screenshot → decide → act → loop) but adds a precision grid overlay that gives the agent near-perfect coordinate targeting, an approach already proven in Sulla's browser-based automation.

## Why

Sulla currently operates within the Electron app and browser contexts. Desktop computer use extends the agent's reach to any application on the machine — terminal emulators, native apps, Finder, System Settings, creative tools — without needing per-app API integrations. The agent can assist with tasks that span multiple applications the same way a human would: by looking at the screen and using the mouse and keyboard.

## Core Concepts

### Grid Overlay for Coordinate Precision

A transparent, click-through Electron window covers the full screen. Just before taking a screenshot, the grid is displayed with labeled lines every 200 pixels both horizontally and vertically. The screenshot is captured (including the grid), then the grid is hidden. The agent receives the screenshot and can reference precise coordinates using the grid labels.

This eliminates the coordinate-guessing problem that plagues vanilla computer use implementations. Instead of estimating "the search bar is roughly in the upper third of the screen," the agent reads "the search bar spans grid columns 2-6 at row 1, centered around (600, 180)."

### Native macOS Input via CGEvent

macOS Core Graphics provides system-level synthetic input APIs:

| API | Purpose |
|-----|---------|
| `CGEventCreateMouseEvent` | Mouse move, click (left/right/double), drag |
| `CGEventCreateKeyboardEvent` | Key down, key up, modifier keys |
| `CGEventCreateScrollWheelEvent` | Scroll in any direction |
| `CGEventPost` | Inject events into the window server event stream |

These are the same APIs that assistive technology and automation tools use on macOS. They work with any application — no accessibility tree parsing required for basic input (though AX APIs can supplement for element discovery).

### Action Loop

```
1. Show grid overlay
2. Capture screenshot (grid visible)
3. Hide grid overlay
4. Send screenshot to agent with tool definitions
5. Agent returns action: { type: "click", x: 450, y: 320 }
6. Execute action via CGEvent
7. Wait for screen to settle (configurable delay)
8. Repeat from step 1
```

## Architecture

### Grid Overlay Window

A dedicated Electron BrowserWindow:

```js
const gridOverlay = new BrowserWindow({
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  focusable: false,
  fullscreen: true,
  skipTaskbar: true,
  hasShadow: false,
  webPreferences: { offscreen: false },
})
gridOverlay.setIgnoresMouseEvents(true)
```

The grid renders labeled horizontal and vertical lines every 200px on a transparent canvas. Line labels show pixel coordinates (0, 200, 400, 600, ...) along the edges. The grid uses a high-contrast color (semi-transparent red or cyan) that is visible on any background.

The overlay is shown/hidden via IPC on each screenshot cycle — it is not always visible.

### Screenshot Capture

Use macOS native `screencapture` or `CGWindowListCreateImage` to capture the full display including the grid overlay. The resulting image is sent to the agent as a base64-encoded PNG.

```
screencapture -x -C -t png /tmp/sulla-screen.png
```

The `-x` flag suppresses the shutter sound. `-C` includes the cursor in the capture.

### Input Execution — Native Addon

A small native Node addon (N-API) wrapping CGEvent calls:

```ts
interface ComputerInput {
  mouseMove(x: number, y: number): void
  mouseClick(x: number, y: number, button?: 'left' | 'right'): void
  mouseDoubleClick(x: number, y: number): void
  mouseDrag(fromX: number, fromY: number, toX: number, toY: number): void
  keyPress(key: string, modifiers?: string[]): void
  typeText(text: string): void
  scroll(x: number, y: number, deltaX: number, deltaY: number): void
}
```

Alternatively, use `@nut-tree/nut-js` which already wraps these macOS APIs in a maintained Node package with mouse, keyboard, and screen capabilities.

### Agent Tool Definitions

The agent receives these tools in its tool schema:

```json
[
  {
    "name": "computer_screenshot",
    "description": "Take a screenshot of the current screen with coordinate grid overlay"
  },
  {
    "name": "computer_click",
    "description": "Click at screen coordinates",
    "parameters": { "x": "number", "y": "number", "button": "left|right", "clicks": "1|2" }
  },
  {
    "name": "computer_type",
    "description": "Type text at the current cursor position",
    "parameters": { "text": "string" }
  },
  {
    "name": "computer_key",
    "description": "Press a key combination",
    "parameters": { "key": "string", "modifiers": ["string"] }
  },
  {
    "name": "computer_scroll",
    "description": "Scroll at a screen position",
    "parameters": { "x": "number", "y": "number", "direction": "up|down|left|right", "amount": "number" }
  },
  {
    "name": "computer_drag",
    "description": "Click and drag from one position to another",
    "parameters": { "fromX": "number", "fromY": "number", "toX": "number", "toY": "number" }
  }
]
```

### Reuse of Annotation Overlay

The grid overlay window shares the same architectural pattern as the Window Annotation System (see `window-annotation-system.md`). Both are transparent, always-on-top, click-through overlay windows. They could share a common base:

```
OverlayWindowManager
  ├── AnnotationOverlay   — freehand drawing for recordings
  └── GridOverlay         — coordinate grid for computer use
```

## Permissions

macOS requires the app to be granted **Accessibility** permission for synthetic input events (System Settings > Privacy & Security > Accessibility). The app should:

1. Check `AXIsProcessTrusted()` on startup or when computer use is first invoked
2. If not trusted, prompt the user with an explanation dialog
3. Open the relevant System Settings pane for them to grant access

Screen recording permission is also required for screenshots (Privacy & Security > Screen Recording). Sulla likely already has this for Capture Studio.

## Safety and Guardrails

Computer use gives the agent significant control. Guardrails are essential:

- **Confirmation mode (default)**: Before executing each action, show the user what the agent intends to do ("Click at (450, 320) — the Safari address bar") and require approval. This can be relaxed to batch-approval or full-auto for trusted workflows.
- **Restricted regions**: Optionally define screen regions the agent cannot interact with (e.g., menu bar, Dock, system dialogs).
- **Kill switch**: A global keyboard shortcut (e.g., Cmd+Shift+Escape) immediately halts the agent loop and disables computer use. This must work even when the agent has focus.
- **Action log**: Every action the agent takes is logged with timestamp, screenshot before/after, and the agent's reasoning. This creates an audit trail.
- **Rate limiting**: Cap actions per minute to prevent runaway loops.
- **Timeout**: If the agent takes no meaningful action (same screenshot, repeated failed clicks) for N cycles, pause and alert the user.

## UX Considerations

- **Observer mode**: The user can watch the agent work in real time — mouse movements are visible, typing appears on screen. This builds trust and lets the user intervene.
- **Grid visibility**: The grid flashes for only the duration of the screenshot capture (< 100ms). The user should barely notice it during normal operation.
- **Multi-display**: Support selecting which display the agent operates on. Grid and screenshots should be per-display.
- **Cursor indicator**: Optionally render a distinctive cursor trail or highlight circle at the agent's current target position so the user can follow along.

## Implementation Phases

### Phase 1 — Grid Overlay + Screenshot Loop

- Create the transparent grid overlay BrowserWindow
- Implement show/hide/capture cycle
- Deliver annotated screenshots to the agent context
- Verify grid coordinates align with actual screen pixels across display scales (Retina)

### Phase 2 — Native Input

- Build or integrate native input module (CGEvent addon or @nut-tree/nut-js)
- Implement mouse move, click, double-click, drag
- Implement keyboard typing and key combinations
- Implement scrolling
- Request and verify Accessibility permissions

### Phase 3 — Agent Integration

- Define computer use tools in agent tool schema
- Implement the screenshot → decide → act loop
- Add confirmation mode UI (approve/deny/auto-approve)
- Add kill switch (global shortcut)
- Action logging and audit trail

### Phase 4 — Polish and Safety

- Multi-display support
- Restricted regions configuration
- Rate limiting and timeout detection
- Cursor indicator overlay
- Adaptive grid density (configurable px spacing, auto-adjust for resolution)
- Integration with existing overlay window manager (shared with annotation system)

## File Structure (Proposed)

```
pkg/rancher-desktop/
  main/
    computerUse/
      gridOverlay.ts              — Grid overlay BrowserWindow manager
      screenshotCapture.ts        — Screenshot capture and grid cycle
      inputExecutor.ts            — CGEvent wrapper or nut-js integration
      computerUseLoop.ts          — Screenshot → agent → action loop
      permissions.ts              — Accessibility/Screen Recording permission checks
      safety.ts                   — Rate limiting, kill switch, restricted regions
  native/
    computer-input/               — N-API addon for CGEvent (if not using nut-js)
      binding.gyp
      src/
        computer_input.mm         — Obj-C/C CGEvent implementation
      index.ts                    — TypeScript bindings
  assets/
    grid-overlay.html             — Full-screen transparent grid canvas
  pages/capture-studio/
    composables/
      useComputerUse.ts           — Agent-side computer use tool handlers
      useGridOverlay.ts           — Grid overlay state and IPC
```

## Relationship to Existing Systems

- **Window Annotation System**: Shares the transparent overlay pattern. The grid overlay and annotation overlay should be managed by a common overlay window manager to avoid conflicts (z-order, mouse event routing).
- **Capture Studio**: Screenshots and screen recording permissions overlap. Reuse existing permission flows.
- **Browser Automation (Playwright)**: Computer use replaces the need for Playwright in desktop contexts. For web-only tasks, Playwright may still be more efficient (direct DOM access, faster, no coordinate guessing). The agent should choose the right tool for the context.
- **Sulla Agent Loop**: Computer use tools plug into the existing agent tool schema alongside file editing, terminal, and browser tools. The agent decides when desktop interaction is the right approach.
