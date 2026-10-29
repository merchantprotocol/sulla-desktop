---
slug: sulla-repository
kind: system
name: Sulla Desktop repository
parent: sulla
aliases: [sulla-desktop repo, merchantprotocol/sulla-desktop, source code, repository]
---

## Overview
The Sulla Desktop repository is the source for the Electron desktop app, its agent harness, VM runtime integration, bundled services, and packaging. The main application code is under `pkg/sulla-desktop`; container services are under `services`; documentation and the memory seed are under `resources`. Use `yarn`, not npm, for repository commands. Sulla Desktop is licensed GPL-2.0-or-later across the whole repository; third-party files keep their own notices. Sulla Server (team seats, the admin console and server accounts) lives in the separate private repository merchantprotocol/sulla-server under its own license.

## Building plugins against this repo
The canonical plugin contract is `docs/extension-contract-v1.md`; the practical guides are under `docs/extensions/`. Copy a matching starter from `examples/extensions/hello-*` or a complete pattern from `examples/use-cases/`, then verify every field against the current loader and tool manifests. Marketplace authoring tools live in `pkg/sulla-desktop/agent/tools/marketplace/`; recipe lifecycle tools live in `pkg/sulla-desktop/agent/tools/extensions/`; hooks and UI registries live in `pkg/sulla-desktop/agent/extensions/`; signed integration loading lives in `pkg/sulla-desktop/agent/integrations/`. To improve Sulla itself, create a branch, make the smallest scoped change, validate it, push it, and open a pull request to `merchantprotocol/sulla-desktop` without pushing directly to the target branch.

## Facts
- `pkg/sulla-desktop/agent` contains agent nodes, prompts, tools, memory, workflows, integrations, built-in agents and skills, database migrations, and agent services.
- `pkg/sulla-desktop/main` contains Electron main-process services, IPC, cloud and device sync, audio drivers, browser tabs, containers, vault integration, and threat proxy.
- `pkg/sulla-desktop/pages`, `components`, `layouts`, `composables`, and `controllers` contain the Vue renderer UI and its controller logic.
- `pkg/sulla-desktop/backend` integrates the VM and container runtime; `window`, `entry`, `runtime`, `shared`, `store`, and `vault-broker` support app startup and secure boundaries.
- `services/sulla-accounts` provides account and Keycloak configuration; `sulla-agent` and `sulla-agents` run agent execution; `sulla-console` provides the server console.
- `services/sulla-files` provides the Files service and `sulla-files-fuse` provides its FUSE mount; `sulla-postgres` provides Postgres; `sulla-relay` provides the cloud relay.
- `services/sulla-threat-proxy` provides threat-proxy filtering; `sulla-tools` is the tool-side service; `sulla-vault` owns credential storage and broker operations; `sulla-workflows` runs workflow services.
- `resources/memory-seed` is the versioned seed pack for subject memory on a fresh install; it replaces the retired bundled reference pack.
- `scripts/` contains build, packaging, asset, runtime, lint, migration-catalog, and development scripts; `examples/` contains extension and use-case examples.
- `justfile` exposes `just install`, `just build`, `just package`, `just dev`, `just start`, `just stop`, `just test-all`, and signing/install recipes; inspect it before running a recipe.
- `yarn.lock` is authoritative for JavaScript dependencies. Build from source with `yarn install`, `yarn build`, and `npx electron .` as documented by `README.md`.
- Database migrations live in `pkg/sulla-desktop/agent/database/migrations`; seeders live in `pkg/sulla-desktop/agent/database/seeders` and are registered from their index files.
- Tool manifests live in `pkg/sulla-desktop/agent/tools/*/manifests.ts` and the category registry; prompt sections live in `pkg/sulla-desktop/agent/prompts/sections`.
- Built-in agent and skill definitions are JSON in `pkg/sulla-desktop/agent/builtinAgents/builtin-agents.json` and `pkg/sulla-desktop/agent/builtinSkills/builtin-skills.json`, with seeders beside them.

## Rules
- DO: Read `AGENTS.md` and `CLAUDE.md` before changing source. Why: repository license and agent constraints are authoritative.
- DO: Update the relevant manifest, migration index, seeder, or registry when adding a repository extension. Why: unregistered code is not loaded.
- DON'T: Use npm commands or remove license headers. Why: this repository uses Yarn, and every source file must keep its SPDX license header.
- DON'T: treat README marketing or legacy docs as proof of a current feature. Why: verify behavior in current source.
