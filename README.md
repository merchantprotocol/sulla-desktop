<div align="center">
  <img src="https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/resources/icons/logo-sulla-desktop-nobg.png" alt="Sulla Desktop" width="200" />
  <h1>Sulla Desktop</h1>
  <p><strong>Your private AI executive assistant that runs on your machine.</strong></p>
  <p>Free to use, desktop-native autonomous agent with persistent memory, calendar engine, Docker workspaces, and n8n automation — all yours to own and extend.</p>
  <p>
    <a href="https://github.com/merchantprotocol/sulla-desktop/releases/latest">
      <img src="https://img.shields.io/github/v/release/merchantprotocol/sulla-desktop?label=Latest&color=green" alt="Latest Release" />
    </a>
    <a href="LICENSE">
      <img src="https://img.shields.io/badge/License-Apache%202.0%20%2B%20Commons%20Clause-blue.svg" alt="Apache 2.0 + Commons Clause" />
    </a>
    <a href="https://github.com/merchantprotocol/sulla-desktop/stargazers">
      <img src="https://img.shields.io/github/stars/merchantprotocol/sulla-desktop?style=flat&color=yellow" alt="GitHub Stars" />
    </a>
  </p>
</div>

<div align="center">
  <img src="./preview.gif" alt="Sulla preview" width="600" />
</div>

Designed for people who live in n8n, love building workflows, code by feel, or simply have too many high-value tasks and not enough hours. No subscriptions. No cloud lock-in.

## Sulla Desktop — Your Personal AI Assistant Layer

**Delegate like you have a full-time technical co-founder — without the payroll.**

**Perfect for** ai automation enthusiasts, vibe coders, business owners, agency owners, and operators who want more output without more hours or headcount.

You’ll Be Able To:

**Ship AI Workflows & Automations 5–10× Faster**  
(Search 9000+ templates, customize, deploy — minutes not days)

**Delegate Multi-Step Technical Projects With Confidence**  
(Planning, coding, Docker, memory updates — handled)

**Own Your Context & Memory Forever**  
(Vector DB + markdown plans that never vanish)

## Core Specs

- Node-graph workflow editor with parallel execution, loops, and checkpoints
- Multi-agent system with per-agent integrations and orchestrator escalation
- Integrated terminal, Monaco code editor, and Git pane
- Training system — capture conversations and fine-tune models
- Calendar engine with auto-wake events
- Docker workspaces with container management and shell access
- n8n integration — search/import thousands of templates
- Live monitoring dashboard with per-endpoint graphs
- Multiple theme presets (default, nord, ocean, protocol) with dark/light modes
- Runs on consumer hardware (8–16 GB RAM recommended)
- Source-available (Apache 2.0 + Commons Clause) — fork, extend, own it

## Install

One command. Works on **macOS**, **Linux**, and **Windows** (Git Bash or WSL).

```bash
curl -fsSL https://sulladesktop.com/install.sh | sh
```

**What it does:**
1. Downloads the latest pre-built release from GitHub
2. Installs the app (DMG/ZIP on macOS, MSI on Windows, ZIP on Linux)
3. Handles macOS Gatekeeper automatically (no "damaged app" warnings)

No build tools required — just `curl`.

> **Developer?** Use `install-dev.sh` to build from source instead.

### Manual install

```bash
git clone https://github.com/merchantprotocol/sulla-desktop.git
cd sulla-desktop
yarn install
NODE_OPTIONS="--max-old-space-size=12288" yarn build
npx electron .
```

### After install

Step 1 — Connect any LLM (local Ollama or remote API)  
Step 2 — Start delegating

## Your No-Hassle Ownership Promise

100% source-available. No subscriptions. No usage caps. No data sharing.
Install it, run it, modify it — it’s yours.

## Frequently Asked Questions

**How much hardware do I need?**  
8 GB RAM minimum (runs well), 16 GB+ ideal for faster inference. Works on most modern laptops/desktops.

**How fast can I expect real results?**  
Workflow velocity and delegation confidence build in 7–30 days of consistent use. Results scale with your task volume.

**Is it fully local?**  
Core agent, memory, tools, and execution run 100% on your machine. LLM inference can be local (Ollama) or remote (your choice for speed/privacy balance).

**How do I extend it?**
Build custom workflow nodes, add tool integrations, or create new agent configurations. Everything is modular and documented.

**Who is this really for?**  
Anyone who lives in n8n, codes by vibe, or has more high-leverage tasks than time — and wants to stop paying specialists to do what their own machine can handle.

Install Sulla Desktop today.  
You deserve an assistant that scales with you, not against you.

— Jonathon Byrdziak  
Coeur d’Alene, Idaho  
Founder, Sulla Desktop

## License

Forked from Rancher Desktop<a href="https://github.com/rancher-sandbox/rancher-desktop" target="_blank" rel="noopener noreferrer nofollow"></a>
Licensed under Apache 2.0 with the [Commons Clause](LICENSE) restriction. See [LICENSE](LICENSE) for details.

**In short:** You can use, modify, and fork Sulla Desktop freely — including for internal commercial use. You **cannot** rebrand, white-label, or resell it as your own product. See the [Trademark Policy](TRADEMARK.md) for branding requirements.

Original copyright: © Rancher Labs, Inc. and contributors.
