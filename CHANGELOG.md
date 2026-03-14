# Changelog

All notable changes to Sulla Desktop will be documented in this file.

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
