---
slug: sulla-vm
kind: system
name: Sulla VM
parent: sulla
aliases: [VM, Sulla runtime, exec, exechost, /mnt/worktrees, guest]
---

## Overview
The Sulla VM is the isolated Linux guest, run by Sulla's own macOS runtime, where agent shell commands run. `/tmp` is on disk. The guest root filesystem and home directory don't survive a restart. Persistent work belongs under `/mnt/data`, exposed as `/mnt/worktrees` for development and scratch. Managed human files appear at `/mnt/sulla-files`; the host home and external volumes are not mounted. `exechost` is a separate, last-resort host escape hatch controlled by Administrative Access.

## Facts
- The VM keeps persistent agent worktrees at `/mnt/worktrees`, backed by `/mnt/data/worktrees`.
- Agent container workspaces live under `/mnt/data/sulla/runtime/agents` and may be used directly for job-local scratch.
- App resources are mounted read-only into the VM; selected host content is reached through Files, not raw host paths.
- Core VM ports are PostgreSQL 30116, Redis 30117, Python 30118, Shell 30119, and Node.js 30120.
- The host gateway is `192.168.5.2`; prefer reaching a host-side network service from the VM over running host shell commands.

## Rules
- DO: Use `/mnt/worktrees/<repo>-<branch>` for code and `/mnt/worktrees/_scratch/<job-id>/` for scratch. Delete scratch when finished.
- DON'T: Assume the host home is mounted or that a host path is valid in the VM.
- DON'T: Use AppleScript to open Terminal for shell commands. Use VM `exec`, or `exechost` only for a verified host-only need.
- DO: Treat restarts as destructive to work outside `/mnt` and `/tmp`, and to active agents. Preserve important work on persistent storage first.
