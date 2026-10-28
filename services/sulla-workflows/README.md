# Sulla Workflows core

GPL-2.0-or-later workflow engine and Desktop manager/runner image. Desktop remains the default mode and its local token, schedules, definitions, launcher and tool behavior are unchanged.

`src/adapter.ts` defines Workflows adapter API v1. Sulla Server's tenant auth, schedule grants and Server Agents routing live in `merchantprotocol/sulla-server`. Its manager and runner images are derived from the same exact Desktop Workflows digest as `ghcr.io/merchantprotocol/sulla-server-workflows-manager` and `ghcr.io/merchantprotocol/sulla-server-workflows-runner`. The shared service imports the playbook and capability contracts from `packages/workflow-engine` and `packages/runtime-protocol`, never the Electron tree.
