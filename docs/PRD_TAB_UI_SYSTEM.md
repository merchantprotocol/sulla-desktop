# PRD: Tab/UI System

**Component:** Frontend chat interface — message display, user input, voice mode coordination
**Status:** Draft
**Date:** 2026-03-20

---

## Overview

The Tab/UI System is the primary user-facing interface of Sulla Desktop. It handles multi-tab chat sessions, renders messages of various kinds, accepts text and voice input, coordinates voice recording and TTS playback, and provides an onboarding landing page for new users.

---

## Current Architecture

### Key Files

| File | Role |
|------|------|
| `pkg/rancher-desktop/pages/BrowserTabChat.vue` | Main chat tab component: message display, auto-scroll, tool card expansion, voice state coordination, thinking/streaming display, first-chat detection, context menus, title generation, continue button |
| `pkg/rancher-desktop/pages/agent/AgentComposer.vue` | Text input textarea with auto-grow, model selector dropdown, send/stop/continue buttons, recording indicator (level meter + timer), TTS speaker button, mic start button |
| `pkg/rancher-desktop/pages/agent/ChatInterface.ts` | Chat controller class: wraps AgentPersonaService, manages messages array, threadId, query ref, localStorage persistence (200 message cap, images stripped), send/stop/continue/newChat/dispose |
| `pkg/rancher-desktop/pages/chat-options/ChatOptionsVariantB.vue` | Landing page (empty state): editorial layout with serif headline, monospace labels, action card grid (Calendar, Integrations, Extensions, Browser), onboarding card, embedded AgentComposer |
| `pkg/rancher-desktop/pages/agent/AgentModelSelectorController.ts` | Model switching: loads providers from integrations catalog, fetches model lists per provider, persists selection to SullaSettingsModel, emits IPC model-changed events |
| `pkg/rancher-desktop/composables/voice/useVoiceSession.ts` | Voice composable: creates VoiceRecorderService + TTSPlayerService + VoicePipeline, bridges service events to Vue refs, auto-cleans up on unmount |
| `pkg/rancher-desktop/pages/chat/ChatContextMenu.vue` | Right-click context menu on chat messages |
| `pkg/rancher-desktop/components/HtmlMessageRenderer.vue` | Renders raw HTML message content safely |
| `pkg/rancher-desktop/pages/editor/workflow/SubAgentBubble.vue` | Renders sub-agent activity bubbles |

### Component Hierarchy

```
BrowserTabChat (tabId prop)
├── ChatContextMenu (right-click overlay)
├── [hasMessages = true]
│   ├── Message list (v-for displayMessages)
│   │   ├── voice_interim → right-aligned italic bubble with red pulse dot
│   │   ├── user → right-aligned bubble (bg-surface-alt)
│   │   ├── tool → collapsible tool card (header, IN/OUT, expandable body)
│   │   ├── sub_agent_activity → SubAgentBubble component
│   │   ├── thinking → truncated italic block with gradient fade (max 100px)
│   │   ├── streaming → assistant bubble with blinking cursor
│   │   ├── html → HtmlMessageRenderer component
│   │   └── default (text) → assistant bubble with markdown rendering
│   ├── Thinking indicator (typing dots, shown when loading or graph running)
│   ├── Speaking indicator ("Sulla is speaking..." with animated wave SVG)
│   ├── Continue button (shown when stopReason === 'max_loops')
│   └── AgentComposer (docked at bottom, border-t)
├── [hasMessages = false]
│   └── ChatOptionsVariantB (landing page)
│       ├── Section label, headline, tagline
│       ├── AgentComposer (embedded)
│       ├── Onboarding card (conditional on isFirstChat)
│       └── Action card grid (Calendar, Integrations, Extensions, Browser)
└── Voice error toast (fixed bottom-center, auto-dismiss 5s)
```

### Message Kinds Reference

| Kind | Source | Display | Notes |
|------|--------|---------|-------|
| `text` (default) | Assistant responses | Left-aligned bubble with Sulla avatar, markdown rendered via marked + DOMPurify | Falls through to the `v-else` branch |
| `user` | User input | Right-aligned bubble (bg-surface-alt) | Matched by `m.role === 'user'` |
| `voice_interim` | Live transcription | Right-aligned italic bubble with red pulse dot | Shown during recording |
| `tool` | Tool executions | Collapsible card with status dot, IN/OUT fields, expandable output/args/result | Uses `m.toolCard` object |
| `thinking` | LLM reasoning | Truncated block (max 100px) with gradient fade, italic, muted color | Content is markdown |
| `streaming` | In-progress response | Assistant bubble with blinking cursor appended | Watched separately for auto-scroll |
| `html` | Rich content | Delegated to HtmlMessageRenderer | Supports dark mode via isDark prop |
| `sub_agent_activity` | Delegated tasks | SubAgentBubble component | Uses `m.subAgentActivity` |
| `workflow_node` | Workflow execution | Not currently rendered in template | Referenced in hasMessages/displayMessages filter |
| `speak` | TTS audio | Hidden (filtered out in displayMessages) | Handled by TTSPlayerService only |
| `action_live_n8n_event` | n8n webhook events | Hidden (filtered out in displayMessages) | Metadata-based kind |

### Props Threading (Voice State)

Voice state currently flows through 4 levels of props and events:

```
useVoiceSession (composable in BrowserTabChat)
  → BrowserTabChat (owns refs: isRecording, audioLevel, recordingDuration, isTTSPlaying)
    → ChatOptionsVariantB (receives as props, re-emits events)
      → AgentComposer (receives as props, emits toggle-recording / stop-tts)
```

Events flow back up: `AgentComposer @toggle-recording` → `ChatOptionsVariantB @toggle-recording` → `BrowserTabChat voice.toggleRecording()`.

### localStorage Persistence

- **Key format:** `chat_messages_{channelId}_{tabId}` and `chat_has_sent_message_{channelId}_{tabId}`
- **Max messages:** 200 (oldest trimmed on persist)
- **Image handling:** `dataUrl` stripped to empty string before storage
- **Large HTML:** Content over 50,000 characters replaced with placeholder
- **Stale tool cards:** On restore, any tool card with `status === 'running'` is marked `failed` with error "Interrupted by page reload"
- **Thread ID:** Persisted and restored by AgentPersonaService; new tabs generate a fresh `thread_{timestamp}_{random}` ID

---

## Problems / Complexity Issues

### 1. BrowserTabChat Does Too Much

BrowserTabChat.vue is a 728-line single-file component responsible for:
- Message rendering (7 distinct message kinds with inline template logic)
- Scroll management (auto-scroll, manual scroll override, streaming content scroll)
- Voice state coordination (bridging useVoiceSession refs to child components)
- Tool card expansion state
- Context menu handling
- Chat title generation from first user message
- First-chat detection and onboarding flow
- Continue button logic
- Voice error toast display and auto-dismiss
- Model selector instantiation
- Markdown rendering with DOMPurify sanitization

This makes the component difficult to test, modify, or reason about.

### 2. Props Threading

Voice state (isRecording, audioLevel, recordingDuration, isTTSPlaying) and voice actions (toggle-recording, stop-tts) pass through 4 component levels. Adding a new voice-related property requires modifying props in BrowserTabChat, ChatOptionsVariantB, and AgentComposer. This is a maintenance burden and violates the principle of keeping data close to where it is consumed.

### 3. Message Display Logic Is Complex

The `displayMessages` computed filters messages by checking multiple conditions (kind, role, content emptiness, presence of image/toolCard/subAgentActivity/workflowNode/channelMeta). The template then has a chain of `v-if` / `v-else-if` / `v-else` blocks, each with its own layout and rendering logic. There is no centralized documentation of what kinds exist, which are hidden, and how each renders.

### 4. No Message Component Registry

Each message kind is rendered inline in the BrowserTabChat template. Adding a new message kind requires:
1. Understanding the existing v-if chain
2. Adding a new v-else-if block in the correct position
3. Implementing the rendering inline (or creating a new component and importing it)
4. Updating the displayMessages filter if the kind should be hidden

There is no plugin or registry pattern that would allow adding a new kind by creating a single file.

---

## Must Have

These features exist today and must continue working without regression.

### MH-1: Multi-Tab Chat with Independent Threads

**As a** user, **I want** to open multiple chat tabs that each maintain their own conversation history and thread ID, **so that** I can work on different topics simultaneously without messages crossing between tabs.

**Acceptance criteria:**
- Each tab has an independent ChatInterface instance keyed by tabId
- Messages in one tab do not appear in another
- Each tab persists its own messages and threadId to localStorage
- Closing and reopening a tab restores its conversation
- The WebSocket channel (`sulla-desktop`) is shared; thread ID filtering prevents cross-tab leakage

### MH-2: Message Display with Kind-Specific Rendering

**As a** user, **I want** each type of message (text, tool output, thinking, streaming, HTML, sub-agent activity, voice interim) to render in its own visual style, **so that** I can quickly distinguish between my messages, assistant responses, tool executions, and system activity.

**Acceptance criteria:**
- User messages render right-aligned in a surface-alt bubble
- Assistant text messages render left-aligned with a "Sulla" avatar and name, markdown content sanitized via DOMPurify
- Tool messages render as collapsible cards with status dot (running/success/failed), tool name, description, IN/OUT fields, and expandable output
- Thinking messages render as truncated italic blocks (max 100px height) with gradient fade edges
- Streaming messages render as assistant bubbles with an appended blinking cursor
- HTML messages render via the HtmlMessageRenderer component with dark mode support
- Sub-agent activity messages render via the SubAgentBubble component
- Voice interim messages render right-aligned with a red pulse indicator and italic text
- Speak messages and action_live_n8n_event messages are hidden from display
- Empty assistant messages (no content, no image, no toolCard, no subAgentActivity, no workflowNode, no channelMeta) are hidden

### MH-3: Text Input with Auto-Growing Textarea

**As a** user, **I want** the message input to automatically grow as I type longer messages and shrink when I delete text, **so that** I can see what I am typing without manually resizing.

**Acceptance criteria:**
- Textarea starts at single-line height (24px)
- Grows to accommodate content up to 400px maximum height
- Switches to multiline layout (full-width, reordered) when content exceeds 50% of available width or contains newlines
- Enter key sends the message; no shift+enter required for newlines (current behavior)
- Textarea uses a hidden mirror element for accurate height measurement

### MH-4: Model Selector Dropdown

**As a** user, **I want** to switch between AI models (local and remote) from a dropdown in the composer, **so that** I can choose the best model for my current task.

**Acceptance criteria:**
- Button in composer shows the currently active model name
- Clicking opens a dropdown menu anchored to the button
- Models are grouped by provider (Local Models, then connected remote providers)
- Each provider group loads its model list asynchronously without blocking the menu
- Selecting a model updates SullaSettingsModel, writes to integration settings, and emits an IPC event
- Active model and provider are visually indicated
- Menu closes on outside click or after selection
- Excluded providers (activepieces, composio, ollama-duplicate) are filtered out

### MH-5: Send / Stop / Continue Buttons

**As a** user, **I want** contextual action buttons that change based on the current state (idle, running, stopped), **so that** I can send messages, interrupt processing, or continue after a pause.

**Acceptance criteria:**
- **Send button** (up-arrow icon): visible when the textarea has content, triggers send on click
- **Stop button** (square icon, red): visible when the graph is running, not recording, and not playing TTS; stops TTS and the graph
- **Continue button** ("Continue" text): visible when stopReason is `max_loops` and graph is not running; resumes processing
- Buttons are mutually exclusive based on state
- Disabled state applied when overlay is showing

### MH-6: Voice Recording Indicator

**As a** user, **I want** to see a visual indicator when voice recording is active, including an audio level meter and elapsed time, **so that** I know the system is listening and can monitor recording duration.

**Acceptance criteria:**
- Recording indicator appears LEFT of the stop button when recording is active and textarea is empty
- Shows a red pulse dot, 5-bar audio level meter (bars light up at 20% increments), and elapsed time in M:SS format
- Stop button (red, pulsing) stops recording on click
- Keyboard shortcut Ctrl+Shift+V (or Cmd+Shift+V on macOS) toggles recording
- Recording indicator is independent of TTS and graph running states

### MH-7: TTS Speaking Indicator

**As a** user, **I want** to see when Sulla is speaking aloud and have a way to mute it, **so that** I know audio output is active and can silence it if needed.

**Acceptance criteria:**
- In the message area: "Sulla is speaking..." text with animated speaker icon (two wave arcs pulsing)
- In the composer: speaker button with animated waves replaces the stop button when TTS is playing
- Clicking the speaker button in the composer stops TTS playback
- Speaker button uses accent-primary color with 15% opacity background
- TTS indicator is independent of recording state

### MH-8: Auto-Scroll with Manual Scroll Override

**As a** user, **I want** the chat to automatically scroll to the latest message, but stop auto-scrolling if I manually scroll up to read earlier messages, **so that** I can review history without being interrupted.

**Acceptance criteria:**
- New messages trigger auto-scroll to bottom (via watch on messages.length)
- Streaming content updates trigger auto-scroll (via watch on last message content when kind is streaming)
- Manual scroll (wheel or touch) disables auto-scroll when the user is more than 140px from the bottom
- Auto-scroll re-enables when the user scrolls back within 140px of the bottom
- Scroll state resets appropriately on new messages after user re-engages

### MH-9: First-Chat Onboarding Flow

**As a** new user, **I want** to be guided through an onboarding experience on my first visit, **so that** Sulla can learn about my goals and working style.

**Acceptance criteria:**
- `isFirstChat` is checked via IPC call `check-first-chat` on mount
- When true, an onboarding card appears on the landing page with title "Start Onboarding for Maximum Effectiveness" and description
- Clicking the card sets a predefined query ("I'm new here -- help me set my goals..."), marks first chat complete via IPC, and sends the message
- Once dismissed, the onboarding card never appears again
- Onboarding card has a fade-in animation

### MH-10: Landing Page with Action Cards

**As a** user with no active conversation, **I want** to see a landing page with quick-action cards, **so that** I can start a new task with one click.

**Acceptance criteria:**
- Landing page (ChatOptionsVariantB) appears when `hasMessages` is false
- Shows editorial layout: monospace section label ("Sulla AI Assistant"), serif headline ("What can I help with?"), tagline
- AgentComposer is embedded for immediate text/voice input
- Four action cards in a 2-column grid: Calendar, Integrations, Extensions, Browser
- Each card emits a `pick` event with its mode, which triggers `set-mode` on the parent
- Cards have a left accent bar that turns to link color on hover, with an arrow indicator

### MH-11: Tool Card Expansion / Collapse

**As a** user, **I want** to expand tool execution cards to see their full output, and collapse them to save space, **so that** I can investigate tool results when needed without cluttering the chat.

**Acceptance criteria:**
- Tool cards are collapsed by default
- Collapsed view shows: status dot, tool name, description, and chevron
- Collapsed view also shows IN field (input command) and OUT field (exit code: 0 for success, 1 for failed) when input exists
- Expanded view additionally shows: output (pre-formatted), or arguments (JSON), or result, and any error message
- Clicking the header toggles expansion
- Chevron rotates 180 degrees when expanded
- Expansion state is tracked per-message in a Set (not persisted across reloads)

### MH-12: Context Menus on Messages

**As a** user, **I want** to right-click on a message to access contextual actions, **so that** I can perform operations like copying or starting a new chat.

**Acceptance criteria:**
- Right-click anywhere in the chat area triggers a custom context menu (native context menu is prevented)
- The menu receives the text content of the clicked message bubble (user or assistant)
- "New Chat" option is available in the context menu
- Context menu is implemented as a separate ChatContextMenu component

### MH-13: Chat Title Generation from First Message

**As a** user, **I want** each chat tab to automatically get a descriptive title based on my first message, **so that** I can identify conversations in the tab bar.

**Acceptance criteria:**
- Title is generated from the first user message content (no LLM call)
- Uses the first sentence or line of the message
- Truncated at approximately 40 characters on a word boundary with an ellipsis
- Title is set via `updateTab(tabId, { title })` on the tab system
- One-shot watcher: stops watching after the first user message is found
- Falls back to "New Chat" for empty content

### MH-14: localStorage Message Persistence

**As a** user, **I want** my chat history to survive page reloads, **so that** I do not lose my conversation when the app restarts.

**Acceptance criteria:**
- Messages are persisted to localStorage on every change (watch with deep: true)
- Maximum 200 messages stored (oldest are trimmed)
- Image dataUrls are stripped (set to empty string) to save storage space
- HTML content over 50,000 characters is replaced with a placeholder
- On restore, tool cards with `status === 'running'` are marked as `failed` with error "Interrupted by page reload"
- Storage key is scoped by channelId and tabId: `chat_messages_{channelId}_{tabId}`
- Storage failures are silently ignored (graceful degradation)

---

## Should Have

Improvements to the existing system that address documented complexity issues.

### SH-1: MessageRenderer Component with Registry Pattern

**As a** developer, **I want** a registry-based message rendering system where each message kind has its own component file, **so that** I can add a new message kind by creating one file without modifying BrowserTabChat's template.

**Acceptance criteria:**
- A `MessageRenderer.vue` component accepts a `ChatMessage` and delegates rendering to the correct sub-component
- Each kind has its own component (e.g., `messages/UserMessage.vue`, `messages/ToolCardMessage.vue`, `messages/ThinkingMessage.vue`, etc.)
- A registry maps kind strings to components, with a default fallback for standard assistant text
- Adding a new kind requires: (1) creating the component, (2) adding one entry to the registry
- BrowserTabChat's template is reduced to `<MessageRenderer v-for="m in displayMessages" :message="m" />`
- All existing rendering behavior is preserved exactly

### SH-2: VoiceStateProvider (Shared Provide/Inject)

**As a** developer, **I want** voice state (isRecording, audioLevel, recordingDuration, isTTSPlaying) and voice actions (toggleRecording, stopTTS) to be available via Vue's provide/inject system, **so that** any descendant component can access voice state without props threading through intermediate components.

**Acceptance criteria:**
- BrowserTabChat provides voice state and actions via `provide(VOICE_KEY, ...)`
- AgentComposer injects voice state directly instead of receiving it as props
- ChatOptionsVariantB no longer needs to receive or re-emit voice props/events
- The useVoiceSession composable remains unchanged; only the consumption pattern changes
- Voice state remains reactive and read-only for consumers
- Props for voice state are removed from AgentComposer and ChatOptionsVariantB interfaces

### SH-3: ChatStateManager (Extract Composables from BrowserTabChat)

**As a** developer, **I want** scroll management, first-chat detection, continue button logic, and tool card expansion state extracted into focused composables, **so that** BrowserTabChat becomes a thin layout component that composes behavior rather than implementing it inline.

**Acceptance criteria:**
- `useChatScroll(messagesRef)` composable handles: auto-scroll enabled/disabled state, scroll listener attachment, scroll-on-new-message watch, scroll-on-streaming watch
- `useFirstChat(chatController)` composable handles: isFirstChat check, startOnboarding action, IPC calls
- `useToolCardExpansion()` composable handles: expandedToolCards Set, toggleToolCard function
- BrowserTabChat's script section is reduced to composable calls and minimal wiring
- All existing behavior is preserved exactly

### SH-4: Independent State Indicators

**As a** user, **I want** clear, non-conflicting visual indicators for recording, TTS playback, and graph processing, **so that** I always know what the system is doing without confusing one state for another.

**Acceptance criteria:**
- Recording indicator, TTS indicator, and graph-running indicator can all be visible simultaneously when their respective states are active
- Current mutual exclusion in the composer (v-if/v-else-if chain for TTS button vs stop button vs mic button) is replaced with independent visibility rules
- Each indicator has a distinct visual style that does not overlap with others
- The thinking dots indicator correctly reflects only graph-running state, not TTS state (currently: `loading || (graphRunning && !isTTSPlaying)`)
- State transitions are smooth (no flickering between indicators)

---

## Nice to Have

Features that do not exist today but would enhance the user experience.

### NH-1: Message Search and Filter

**As a** user, **I want** to search through my chat history by keyword, **so that** I can find a specific message or topic from a previous conversation.

**Acceptance criteria:**
- Search input appears in the chat header or as a toggleable overlay
- Filters displayMessages in real-time as the user types
- Highlights matching text within message content
- Shows match count
- Navigate between matches with up/down arrows or Enter

### NH-2: Message Editing

**As a** user, **I want** to edit a previously sent message and re-submit it, **so that** I can correct mistakes or refine my request without retyping the entire message.

**Acceptance criteria:**
- Double-click or context menu action on a user message enters edit mode
- The message content becomes an editable textarea
- Saving the edit re-sends the message to the backend (optionally truncating the thread to that point)
- Cancel exits edit mode without changes
- Edited messages are visually marked as edited

### NH-3: Chat Thread Sidebar

**As a** user, **I want** a sidebar listing all my chat threads with their titles and timestamps, **so that** I can navigate between conversations without relying solely on tabs.

**Acceptance criteria:**
- Sidebar lists all persisted chat threads from localStorage
- Each entry shows the title and last message timestamp
- Clicking an entry opens that thread in the current tab
- Threads can be deleted from the sidebar
- Sidebar is collapsible

### NH-4: Keyboard Navigation Between Messages

**As a** user, **I want** to navigate between messages using keyboard shortcuts, **so that** I can review the conversation without using the mouse.

**Acceptance criteria:**
- Up/Down arrow keys (when textarea is not focused) navigate between messages
- Currently focused message is visually highlighted
- Enter on a focused message copies its content or opens a context menu
- Escape returns focus to the textarea
- Navigation wraps or stops at conversation boundaries

### NH-5: Drag-and-Drop File Upload

**As a** user, **I want** to drag a file into the chat area to attach it to my next message, **so that** I can share images, documents, or other files without using a file picker dialog.

**Acceptance criteria:**
- Dragging a file over the chat area shows a drop zone overlay
- Dropping a file attaches it to the next message (preview shown in composer area)
- Supported file types: images (displayed as thumbnails), text files (content inlined), other files (shown as attachment cards)
- Multiple files can be dropped at once
- File size limits are enforced with user-facing error messages

---

## Technical Notes

### Ports (for reference)

| Port | Service |
|------|---------|
| 3000 | ChatCompletionsServer |
| 6107 | HttpCommandServer |
| 6108 | Terminal WebSocket Server |
| 6120 | Dashboard |
| 30118 | WebSocket |

### Dependencies

- **marked** — Markdown to HTML rendering
- **dompurify** — HTML sanitization (allows audio/source tags, data URIs for images)
- **Vue 3** — Composition API, refs, computed, watch, provide/inject
- **AgentPersonaService** — Backend communication via WebSocket, thread management
- **VoiceRecorderService** — Microphone capture and audio level monitoring
- **TTSPlayerService** — Text-to-speech audio playback
- **VoicePipeline** — Coordinates recording, transcription, and TTS flow
- **SullaSettingsModel** — Persistent key-value settings store
- **IntegrationService** — Provider and model catalog management
