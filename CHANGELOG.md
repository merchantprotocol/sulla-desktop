# Changelog

All notable changes to Sulla Desktop will be documented in this file.

## [1.3.0] - 2026-04-09

### New Features

- **Capture Studio** — full audio/video capture studio with multi-source recording, scene management, source context menus, loading screen, permissions UX, disk warnings, and keyboard shortcuts
- **Audio driver integration** — built-in audio subsystem with independent mic/speaker lifecycle, 48kHz native PCM pipeline, RNNoise noise reduction, VAD-driven voice chat, and mic recording mode selector
- **Local LLM overhaul** — section-based prompt composition (OpenClaw parity), streaming, caching, speculative decoding, native context clamping, KV cache optimization, and Gemma 4 support
- **ModelProviderService** — centralized model provider management with cache invalidation on model change and local server toggle persistence
- **GLM-4.7 Flash** — new local model option for fast inference
- **Bundled whisper-cli** — pre-built whisper binary removes Homebrew dependency; auto-install fallback when bundled binary is missing
- **Computer Use** — TCC permission probe for macOS dialogs, AppleScript app automation settings, and Computer Use Settings panel
- **Teleprompter** — floating window near webcam for eye-contact reading, VAD-gated speech tracking with Jaccard fuzzy matching, main process tracking, close button, and style sync to floating window
- **Agent session context** — agent reads identity, goals, and tool reference at session start; thinking bubble collapses on stream start
- **write_file tool** — new agent tool for file creation
- **browse_tools catalog** — completed and promoted to meta tools
- **ServiceLifecycleManager** — dependency-aware startup/shutdown ordering
- **HeartbeatNode** — expanded GraphRegistry for agent orchestration
- **Tray panel** — custom tray panel UI with vault password verification and graceful shutdown
- **Settings IPC** — cast/delete support and resetOllamaService helper
- **Editor chat** — multi-tab system, chat history, scroll-to-bottom, chat options, and focus management
- **Version in footer** — app version now displayed in the workbench status bar

### Improvements

- Audio permission gates and chat injection improvements
- Capture event logging and window focus tracking
- Open all URLs inside Sulla Desktop instead of external browser
- Raised loop detection threshold with detached start/stop
- Condensed local LLM prompts with llama.cpp auto-update on startup
- Simplified agent and editor headers with shared WindowDragLogo
- Split CaptureStudio.vue into 8 sub-components for maintainability

### Bug Fixes

- Fixed agent requirement blocking initial install
- Fixed llama-server 503 retry and performance tuning
- Fixed local LLM agent reliability — correct model, context, timeouts, and prompt mode
- Fixed RNNoise FIFO buffer eliminating clicking artifacts
- Stopped muxing mic audio into screen/camera recordings
- Fixed camera preview showing live video and streams following source assignment
- Fixed audio driver boot timeout and camera stream flickering
- Fixed audio meters, inline playback, and muxed audio in video files
- Fixed auto-start audio driver when Capture Studio opens
- Comprehensive reliability audit — fixed 55 identified issues across capture pipeline
- Defensive null guards on all composable ref accesses
- Wrapped capture studio IPC handlers in try-catch to prevent main crash
- Fixed vault initialization before integrations to ensure Slack tokens are decrypted
- Fixed RedisClient reconnect loop blocking exit on shutdown
- Fixed guarded-attribute filter logic in BaseModel save()
- Fixed uncontrolled data used in path expression (security scan alert #4514)
- Fixed teleprompter style sync to floating window
- Fixed whisper-cpp brew install with proper timeout handling

### Refactoring

- Removed `load_skill` tool — `read_file` covers the same use case
- Refactored audio driver into MicrophoneDriverController and SpeakerDriverController
- Replaced Ollama references with llama.cpp throughout documentation

## [1.2.0] - 2026-04-02

### New Features

- **Password vault** — encrypted credential storage with master password unlock, browser autofill, in-page dropdown UI, save toast after submit, and smart duplicate detection
- **Vault import/export** — import from Bitwarden, LastPass, 1Password, and generic CSV; export as plain text JSON or encrypted backup
- **Vault security badge** — shows AES-256 Encrypted status when active
- **Bitwarden-style password generator** with strength meter
- **WebContentsView browser tabs** — replaced iframe-based tabs with native Electron WebContentsView for full Chrome-like browsing
- **Side panel chat** — per-tab side panels with rich context, overlay guard, and layout fixes; wired up for right-click AI actions
- **Conversation history system** — centralized ConversationHistoryService with UI, agent tools, Chrome API bridge, auto-expose tools, browser tab tracking, and auto-titles
- **Sulla CLI** — proxy, daemon relay, and integration tooling via `sulla-tool` CLI
- **Subconscious middleware** — background processing layer for agent system
- **Chrome API layer** — `chrome.*` API surface for AI agents and future extension support, with CDP trusted keyboard events and multi-tab bridge isolation
- **Login/logout system** — vault auto-unlock, menu locking, tray item state management, and profile menu with logout
- **My Account page** — profile editing, password change, and vault stats
- **Browser context menu** — Shadow DOM context menu with standard and AI actions
- **Application menu restructure** — reorganized for clarity and discoverability; History menu with browser tab tracking
- **Enhanced AccountEditor** — editable labels, textarea notes, multi-URL support, custom fields, LastPass-quality UI
- **URL detection** in chat composer and Chrome-style certificate warnings
- **`__sulla` runtime library** — enhanced `exec_in_page` with dehydrate mode for browser automation
- **Visual browser tools** — screenshot, click-at, CDP interaction, state machine bridge
- **Playwright browser tools overhaul** — `press_key`, `submit`, `aria-label` support, navigation fixes
- **Gateway audio streaming** — WebSocket streaming for secretary mode with reliable reconnect
- **Secretary mode** — instant mute, agent audio playback, transcript UI overhaul
- **GatewayListenerService** — MCP bridge, voice recorder, and chat completions integration
- **Orchestrator abort** — allows orchestrator to abort stuck workflows via `ABORT_WORKFLOW` tag

### Improvements

- Expose chrome and computer-use tools to chat completions endpoint
- Inject `llm_access` property into all integrations and add password visibility toggle
- Unify integrations and vault under Password Manager with restructured menus
- Unify logging into SullaLogger with file-based topic and conversation logging
- Replace WebSocket hub with IPC MessageBus
- All page-changing tools return dehydrated DOM; removed `wait_for_navigation`
- Simplified audio settings: removed secretary transcription mode, conditionally show options
- Removed redundant provider dropdown; hide model unless ElevenLabs selected
- Removed 11 orphaned components replaced by agent router and browser tab interface
- Cleaned up dead WebSocket hub code
- Browser tab prompt instructions updated for `exec_in_page` and `__sulla`
- Agent prompt teaches interaction patterns in `browser_tab` response

### Bug Fixes

- Fixed Slack inbound routing, MCP flat body, API key query param
- Fixed bridge event forwarding from WebContentsView guest to renderer
- Fixed IpcMessageBus forwarding messages to renderer for browser tab creation
- Fixed `browser_tab` to return dehydrated DOM instead of full snapshot
- Fixed `browser_tab` waiting for bridge injection event
- Fixed screenshot capturing correct tab by `assetId`, not just active tab
- Fixed smart credential save: skip duplicates, offer update, better labels
- Fixed vault autofill using BrowserTabViewManager directly
- Fixed vault theme colors, integration picker, `llm_access` defaults
- Fixed vault account click staying in current tab instead of using router
- Fixed tab title updates on vault screen transitions
- Fixed `getVaultKeyService` reference in `migrateToEncrypted`
- Fixed TDZ crash in AgentHeader `orderedTabs` watch
- Fixed 'Open Sulla' tray item staying enabled when logged out
- Fixed menu rebuild on login with async history refresh
- Fixed History menu items disabled when user is logged out
- Fixed dark mode on window
- Fixed integration detail page always creating new connections
- Fixed 'Connect Now' opening full integration detail page
- Fixed AgentHeader hidden in integration detail when embedded in vault tab
- Fixed integration YAML configs loading before listing endpoints
- Fixed tab navigation to fallback tab when last tab closed via API
- Fixed `function.arguments` validation for Alibaba DashScope API
- Fixed unbound variable error when installer runs without arguments
- Fixed `window.getWindow()` usage in `sulla.ts`
- Fixed `pmset` schedule wake (requires root; caffeinate is sufficient)
- Fixed various theme color issues across ocean, dark mode, scrollbars, headers, modals, tabs, and chat UI

### Refactoring

- Environment prompt rewritten with MVC structure
- Removed `dom_observer` passive DOM observation pipeline
- Renamed integration tools to `vault/` category
- Audio driver removed from installer (moved to post-build step)

### Infrastructure & Security

- Pinned all dependencies to exact versions to prevent supply chain attacks
- Pinned `@types/node@22.19.15` and `@types/jest@29.5.14`
- Bumped `actions/download-artifact` from 7.0.0 to 8.0.1
- Bumped `actions/setup-go` from 6.2.0 to 6.3.0
- Bumped `actions/create-github-app-token`
- Fixed HTTPS repository URL for Windows MSI build
- Pre-built installer added with renamed dev scripts and release job in CI

## [1.0.0] - 2026-03-14

First major release of Sulla Desktop — a complete re-architecture from the Rancher Desktop fork into a standalone AI executive assistant.

### Breaking Changes

- **Removed Neo4j database** — the entire article/knowledge graph system (models, registries, migrations, seeders) has been replaced with a lightweight QMD-based storage layer
- **Removed native skill registry** — native skills (daily-intelligence-monitor, elevenlabs-audio-generator, git-operations, n8n integrations, project-management, remotion-video-generator, software-development) have been removed in favor of the new workflow system
- **Removed LLM conversation logger** — replaced by the new training capture system
- **Removed BlockNote editor** — replaced by Monaco editor

### New Features

- **Workflow system** — full node-graph workflow editor with trigger, agent, condition, router, tool-call, flow-control, and I/O nodes; supports parallel execution, loop nodes, transfer nodes, checkpoints, and resume-from-checkpoint
- **Agent management** — multi-agent system with per-agent integrations, conversation switching, thought bubbles, explicit agent contracts, and orchestrator escalation
- **Training system** — capture conversations as OpenAI-compatible JSONL, training scheduler, train-now button, training dashboard and log viewer
- **Terminal integration** — full xterm.js terminal with themed WebSocket PTY server
- **Monaco code editor** — rich code editing with CSS display, diff editor, Git changes view, and file tree sidebar
- **Monitoring dashboard** — live conversation area, per-endpoint graph configuration, agent activity logs
- **Docker pane** — container management with logs and shell access, grouped container view
- **Git pane** — inline diff viewer with added/modified file colors
- **Error reporting** — Cloudflare worker error reporting across app and installer
- **Theme system** — unified categorized CSS variables, multiple theme presets (default, nord, ocean, protocol), dark/light modes, appearance preferences panel
- **Integration tools** — base integration framework with per-agent configuration via API

### Improvements

- Increased default LLM timeout to 180s with per-request `timeoutSeconds` support
- LLM request timeouts, wrapper nudge retry, and Claude Code-style tool cards
- Idempotent restart: preserves Docker containers and fixes logging
- Limited context window handling to prevent spontaneous conversation death
- Multi-turn chat completions with single response support
- QMD search consolidated into a single unified implementation
- Workflow files converted to YAML format
- Branding updated: copyright to Merchant Protocol LLC with SUSE attribution

### Bug Fixes

- Fixed QMD search path resolution by mapping handleized paths back to originals
- Fixed agent git operations (converted to Lima VM shell execution)
- Fixed message handling on agent loops
- Fixed training module in the editor window
- Fixed select color in UI
- Fixed git diff files returning `?`
- Fixed note reanimation when executing from checkpoint
- Fixed build TypeScript errors
- Fixed node-pty spawn-helper permissions (chmod in postinstall)
- Fixed bundling of QMD defaults

### Infrastructure

- CI/CD workflows updated from Rancher Desktop to Sulla Desktop branding
- Artifact names aligned with electron-builder output (`Sulla-Desktop-*`)
- App ID: `io.sulla.desktop`
- Executable name: `sulla-desktop` (Linux)
- Node engine requirement: `>=22.22.0`

## [0.1.1] - Initial Fork

Initial fork from Rancher Desktop with basic AI agent integration.
