# Sulla Agents core

GPL-2.0-or-later Agents service shared by Desktop. Desktop remains the default mode and its token, definitions, UI, tool grants and runner behavior are unchanged.

`src/adapter.ts` defines Agents adapter API v1. Sulla Server's tenant auth, tenant tables, run persistence and launch policy live in the separately licensed `merchantprotocol/sulla-server` adapter and the digest-pinned `ghcr.io/merchantprotocol/sulla-server-agents` derived image. The shared service imports runtime primitives only from `packages/runtime-protocol`; it has no Electron-tree build dependency.
