---
slug: sulla-channels
kind: system
name: Inter-agent channels
parent: sulla
aliases: [channels, inter-agent messaging, channel tags, roster, mobile-relay, heartbeat]
---

## Overview
Agents communicate through named channels. The current roster and human presence arrive in the latest `<turn_context>` block. To send a message, emit an XML channel tag in the reply; the runtime routes it without a tool call. Messages are fire-and-forget and replies arrive on the sender's channel.

## Facts
- A channel message uses `<channel:<name>>message</channel:<name>>`, for example `<channel:heartbeat>Are you online?</channel:heartbeat>`.
- The built-in channels include `sulla-desktop`, `heartbeat`, and `mobile-relay`; use the live roster for current agents and channels.
- The sender channel and sender id are provided in the current turn context.
- Channel tags are protocol content and are stripped from visible chat output by the runtime.
- `sulla/active_agents` is a Redis-backed registry used to build active-agent context; it tracks agent status and last activity.

## Rules
- DO: Include enough context for the recipient to act without a follow-up. Why: delivery is asynchronous.
- DO: Continue useful work immediately after sending a channel message. Why: channel delivery is fire-and-forget.
- DON'T: Poll or search for a channel reply. Why: replies arrive automatically on your channel.
- DON'T: treat the roster in an old message as current. Why: presence and status change every turn.
