---
slug: sulla-docker
kind: system
name: Sulla Docker
parent: sulla
aliases: [Docker, containers, compose, core services]
---

## Overview
Sulla's core services run in Docker inside the Sulla VM. Docker tool execution depends on the active command context and does not universally select the VM daemon or a host daemon. An absent container in one context is not proof that it is stopped. The VM backend owns core compose reconciliation and service startup.

## Facts
- Base VM containers are `sulla_postgres`, `sulla_redis`, `sulla_python_runtime`, `sulla_shell_runtime`, and `sulla_node_runtime`.
- PostgreSQL uses a named volume; Redis persistence is disabled.
- Function runtimes mount VM-owned catalog and invocation directories, not host `~/sulla/functions`.

## Rules
- DO: Check the Docker execution context before interpreting listings or logs.
- DON'T: Restart or remove core services merely because another Docker context cannot see them.
- DON'T: Uninstall and reinstall an extension as a routine restart. Why: Uninstall can remove user data.
