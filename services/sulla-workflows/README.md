# Sulla Workflows service

GPL-2.0-or-later workflow engine and local Desktop manager/runner image. The Desktop manager runs schedules and launches local ephemeral runners; runners call Desktop tools through the scoped local capability API. `SULLA_WORKFLOW_ROLE=manager|runner` selects these two local process roles; there is no server product mode in this service.

The manager and runner use the shared `packages/workflow-engine` and `packages/runtime-protocol` packages. Remote workflow records remain supported by Desktop's UI and model; this service executes only workflows whose location is `desktop`.
