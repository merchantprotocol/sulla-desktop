# Window Annotation System

## Overview

A real-time screen annotation toolkit integrated into the floating teleprompter window. During recording, the user can grab annotation tools from the teleprompter popup and draw directly on screen to highlight, circle, arrow, or mark up whatever they are presenting. Annotations render as a transparent always-on-top overlay that captures into the recording.

## Why the Teleprompter Window

The floating teleprompter window is already:
- Always on top and positioned near the camera
- Visible regardless of which app or layout is focused
- A known interaction point the user glances at while recording
- Small and out of the way

Adding annotation tool icons to this window means the user can grab a pen, arrow, or highlighter without switching apps, opening a menu, or losing their place. One click to pick a tool, draw on screen, one click to dismiss.

## Annotation Tools

### Drawing Tools
- **Pen** — freehand drawing in a configurable color and thickness
- **Highlighter** — semi-transparent wide stroke for emphasizing text or regions
- **Arrow** — click-drag to place directional arrows pointing at things on screen
- **Rectangle** — click-drag to draw outlined or filled rectangles around areas of interest
- **Circle/Ellipse** — click-drag to draw circles or ovals around elements
- **Line** — straight line between two points
- **Text** — click to place a text label on screen

### Controls
- **Color picker** — quick swatches (red, yellow, green, blue, white) plus custom color
- **Thickness** — small/medium/large stroke width
- **Undo** — remove the last annotation
- **Clear all** — remove all annotations from screen
- **Dismiss** — exit annotation mode, return to normal interaction

## Architecture

### Overlay Window
A separate transparent, frameless, always-on-top Electron BrowserWindow that covers the full screen (or the recorded display). This window:
- Is transparent to mouse events when annotation mode is off (`setIgnoreMouseEvents(true)`)
- Captures mouse events when annotation mode is on (`setIgnoreMouseEvents(false)`)
- Renders annotations on a full-screen HTML5 canvas
- Sits above all other windows but below the teleprompter popup
- Is included in screen capture since it is a visible window

### Teleprompter Integration
The teleprompter floating window gets a small toolbar row (collapsible) with annotation tool icons. Selecting a tool:
1. Activates the overlay window for mouse input
2. Sets the active drawing tool and style
3. Cursor changes to crosshair or tool-appropriate cursor
4. User draws on the overlay canvas
5. Clicking the dismiss button or pressing Escape deactivates the overlay

### State Flow
```
Teleprompter Popup                  Annotation Overlay Window
  [pen] [arrow] [rect] [clear]       (full-screen transparent canvas)
         |                                      |
         | IPC: annotation:set-tool             |
         |------------------------------------->|
         |                                      |
         | IPC: annotation:clear                |
         |------------------------------------->|
         |                                      |
         | IPC: annotation:undo                 |
         |------------------------------------->|
```

### Recording Integration
Since the annotation overlay is a real Electron window rendered on screen, it is automatically captured by the existing screen recording pipeline (getDesktopSources / MediaRecorder). No special compositing is needed — the annotations appear in the recording exactly as the user sees them.

### Canvas Rendering
- Use an HTML5 `<canvas>` element covering the full overlay window
- Store annotations as an array of shape objects (`{ type, points, color, thickness, ... }`)
- Re-render the full annotation stack on each change
- Smooth freehand drawing via pointer events with `requestAnimationFrame`

## UX Considerations

- **Non-blocking**: Annotation mode should not interrupt voice tracking or teleprompter scrolling. The user can draw while still reading.
- **Minimal chrome**: The annotation tools in the teleprompter window should be small icons, not a full toolbar. A single row that can collapse to a pen icon.
- **Quick in, quick out**: Picking a tool activates annotation mode. Drawing something and then clicking anywhere outside the overlay (or pressing Escape) deactivates it. Minimize friction.
- **Fade out (future)**: Optionally, annotations could auto-fade after a configurable duration (e.g., 5 seconds) so the user does not need to manually clear them during a recording.
- **Persist across scenes (future)**: Annotations could optionally clear when the user switches layouts or could persist for the duration of the recording session.

## Implementation Phases

### Phase 1 — Overlay + Pen
- Create the full-screen transparent overlay BrowserWindow
- Add a pen icon to the teleprompter floating window
- Implement freehand drawing on the canvas
- Add clear and undo controls
- Verify annotations appear in screen recordings

### Phase 2 — Shape Tools
- Add arrow, rectangle, circle, and line tools
- Add color picker and thickness selector
- Add text annotation tool

### Phase 3 — Polish
- Auto-fade option for annotations
- Keyboard shortcuts (while overlay is active)
- Touch/stylus pressure sensitivity if available
- Animation for arrow/circle drawing (snap to clean shapes)

## File Structure (Proposed)

```
pkg/rancher-desktop/
  main/
    annotationWindow.ts          — Electron BrowserWindow manager for the overlay
  assets/
    annotation-overlay.html      — Full-screen transparent canvas + drawing logic
    teleprompter-float.html      — Updated with annotation tool icons
  pages/capture-studio/
    composables/
      useAnnotation.ts           — Shared state and IPC for annotation tools
```
