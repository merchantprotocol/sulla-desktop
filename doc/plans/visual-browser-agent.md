# Visual Browser Agent + Image Attachments — Implementation Plan

## Overview

Two interconnected features that enable vision-based web interaction:

1. **Image attachments in chat** — users and tools can send images to the model
2. **Visual browser agent** — screenshot-based page interaction with coordinate clicking

## Current State

| Layer | Status | Gap |
|-------|--------|-----|
| `ChatMessage.content` | String only | No image blocks |
| Chat UI (AgentComposer) | Textarea only | No file upload |
| LLM services | String content only | No vision API calls |
| CDP debugger | Keyboard events only | No screenshots, no mouse |
| UI `ChatMessage.image` | Field exists but unused | Never sent to backend |

## Architecture

```
User attaches image ─┐
                      ├─► ChatMessage with image blocks ─► LLM with vision
Tool takes screenshot ┘

LLM sees page screenshot ─► "Click the blue chat button at (1043, 672)"
                                    │
                                    ▼
                          CDP Input.dispatchMouseEvent(x, y)
```

---

## Phase 1: Image Attachments (Foundation)

### 1A. Extend ChatMessage to support image content

**File:** `pkg/rancher-desktop/agent/languagemodels/BaseLanguageModel.ts`

Change `ChatMessage.content` from `string` to `string | ContentBlock[]`:

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
  // ... existing fields
}
```

This is the Anthropic native format. OpenAI and Google adapters convert during `buildRequestBody()`.

### 1B. Update LLM services to handle image content blocks

**AnthropicService.ts** — already supports content blocks natively, just needs to pass them through instead of converting to string.

**OpenAICompatibleService.ts** — convert in `buildRequestBody()`:
```typescript
// Anthropic format → OpenAI format
{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
  →
{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
```

**GoogleService.ts** — convert to Gemini format:
```typescript
{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
  →
{ inlineData: { mimeType: 'image/png', data: '...' } }
```

**OllamaService.ts** — Ollama supports `images` array with base64 strings on vision models.

### 1C. Add attachment button to AgentComposer.vue

**File:** `pkg/rancher-desktop/pages/agent/AgentComposer.vue`

- Add paperclip/attachment icon button to the left of the text input
- File input (hidden) that accepts `image/*,.pdf,.txt`
- On file select: read as base64, show thumbnail preview above the input
- Store pending attachments in a reactive array
- On send: include attachments as `ContentBlock[]` in the message

```
┌──────────────────────────────────────────────┐
│ [📎] [  Type your message...          ] [➤] │
│      ┌──────┐ ┌──────┐                      │
│      │ img1 │ │ img2 │  ← preview thumbnails │
│      └──────┘ └──────┘                      │
└──────────────────────────────────────────────┘
```

### 1D. Update WebSocket message format

**File:** `pkg/rancher-desktop/agent/database/models/AgentPersonaModel.ts`

Extend `addUserMessage()` to accept attachments:
```typescript
async addUserMessage(threadId: string, text: string, metadata?: any, attachments?: ContentBlock[]): Promise<void>
```

The WebSocket payload carries the content blocks. Backend graph nodes pass them through to the LLM.

### 1E. Display images in chat history

**File:** Chat message rendering components

- When a message has image content blocks, render `<img>` tags inline
- For base64 images: `<img src="data:image/png;base64,..." />`
- Add a lightbox/zoom on click

---

## Phase 2: Page Screenshots (CDP Integration)

### 2A. Screenshot IPC handler

**File:** `pkg/rancher-desktop/sulla.ts`

Add a new IPC handler that captures the page:

```typescript
ipcMainProxy.handle('browser-tab:capture-screenshot', async (event, options?: { targetUrl?: string }) => {
  const wc = event.sender;
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach('1.3');
  }

  // CDP Page.captureScreenshot returns base64-encoded PNG
  const result = await wc.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    quality: 80,
    captureBeyondViewport: false,
  });

  return result.data; // base64 string
});
```

### 2B. Screenshot tool for the agent

**File:** `pkg/rancher-desktop/agent/tools/playwright/screenshot.ts`

New tool: `take_screenshot`
- Calls the IPC handler to capture the page
- Returns the base64 image as a content block that gets included in the next LLM message
- Optionally annotates with element bounding boxes

```typescript
schemaDef: {
  assetId:       { type: 'string', optional: true, description: 'Target tab' },
  annotate:      { type: 'boolean', optional: true, description: 'Draw boxes around interactive elements' },
  fullPage:      { type: 'boolean', optional: true, description: 'Capture full scrollable page' },
}
```

### 2C. Wire screenshots into the LLM message flow

When `take_screenshot` is called:
1. Capture PNG via CDP
2. Create a `ContentBlock` with the base64 image
3. Inject it into the conversation as a user message (image block)
4. The model's next response can reference what it sees

---

## Phase 3: Coordinate-Based Mouse Interaction

### 3A. Mouse event IPC handler

**File:** `pkg/rancher-desktop/sulla.ts`

```typescript
ipcMainProxy.handle('browser-tab:send-mouse-event', async (event, mouseEvent) => {
  const wc = event.sender;
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach('1.3');
  }

  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: mouseEvent.type,  // 'mousePressed', 'mouseReleased', 'mouseMoved'
    x: mouseEvent.x,
    y: mouseEvent.y,
    button: mouseEvent.button || 'left',
    clickCount: mouseEvent.clickCount || 1,
  });
});
```

### 3B. Click-by-coordinates tool

**File:** `pkg/rancher-desktop/agent/tools/playwright/click_coordinates.ts`

New tool: `click_at`
- Accepts x, y coordinates
- Sends mousePressed + mouseReleased via CDP
- Returns success confirmation

```typescript
schemaDef: {
  x:       { type: 'number', description: 'X coordinate in pixels' },
  y:       { type: 'number', description: 'Y coordinate in pixels' },
  assetId: { type: 'string', optional: true },
}
```

### 3C. Element annotation overlay

Before taking a screenshot, inject JS that draws numbered bounding boxes around interactive elements:

```javascript
// Injects temporary colored borders with numbers on clickable elements
// Model sees: [1] Search button, [2] Chat icon, [3] Menu
// Model responds: "Click element 2 at coordinates (1043, 672)"
```

This gives the model both a visual reference AND coordinates.

### 3D. Type-at-coordinates tool

New tool: `type_at`
- Clicks at coordinates first (to focus)
- Then sends keyboard events via CDP
- For typing into chat widgets, search boxes, etc. that DOM selectors can't reach

---

## Phase 4: Visual Agent Workflow

### How it works end-to-end:

```
1. Agent opens a website
2. Agent calls take_screenshot(annotate: true)
3. Screenshot is sent to the vision model with annotated element boxes
4. Model sees: "I see a blue chat bubble icon labeled [7] in the bottom-right corner"
5. Model calls click_at(x: 1043, y: 672)
6. Agent calls take_screenshot() again to see the result
7. Model sees: "A chat window opened. There's a text field [12] asking 'How can we help?'"
8. Model calls type_at(x: 520, y: 400, text: "What services do you offer?")
9. Repeat: screenshot → analyze → interact → screenshot
```

### Skill file update

Update `web-research-playwright/SKILL.md` with:
- When DOM handles don't work (chat widgets, shadow DOM, complex UIs)
- Fall back to `take_screenshot` → visual analysis → `click_at`
- Coordinate-based interaction workflow

---

## Implementation Order

| Step | Effort | Dependency | Impact |
|------|--------|------------|--------|
| 1A. ContentBlock message type | Small | None | Foundation for everything |
| 1B. LLM vision support | Medium | 1A | Models can see images |
| 1C. Attachment UI button | Medium | 1A | Users can send images |
| 1D. WebSocket + backend | Small | 1A | Wire it through |
| 1E. Image display in chat | Small | 1D | Visual feedback |
| 2A. Screenshot IPC | Small | None | CDP capture |
| 2B. Screenshot tool | Small | 1A, 2A | Agent can see pages |
| 2C. Wire into LLM flow | Medium | 1B, 2B | Model receives screenshots |
| 3A. Mouse event IPC | Small | None | CDP mouse |
| 3B. Click-at tool | Small | 3A | Coordinate clicking |
| 3C. Element annotation | Medium | 2B | Numbered bounding boxes |
| 3D. Type-at tool | Small | 3A, 3B | Type in unselectable elements |

**Critical path:** 1A → 1B → 2A → 2B → 2C → 3A → 3B → 3C

Phases 1-2 enable the model to see. Phase 3 enables it to interact with anything visible. Phase 4 is the workflow that ties it together.

---

## Risks & Considerations

- **Token cost:** Screenshots are ~1000-2000 tokens each as base64 images. Frequent screenshots in loops could get expensive.
- **Model capability:** Not all models support vision (local Ollama models may not). Need graceful fallback to DOM-based interaction.
- **Coordinate accuracy:** Screenshots must match the actual rendered viewport. Zoom levels, DPI scaling, and iframe offsets need handling.
- **CDP debugger lifecycle:** The debugger must stay attached. Currently attaches on-demand; may need to persist.
- **Privacy:** Screenshots may capture sensitive content. Consider redaction options.
