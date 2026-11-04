---
slug: sulla-heartbeat
kind: system
name: Heartbeat
parent: sulla
aliases: [heartbeat, chat heartbeat, autonomous agent, background agent, proactive work, heartbeatWindow]
---

## Overview
Sulla has two distinct heartbeat systems. A chat heartbeat belongs to one thread and lets its current agent wake itself while a multi-step goal is unfinished. The always-running Heartbeat agent is a separate autonomous agent on the `heartbeat` channel. It pursues the install's north star, runs reversible experiments, and keeps an idea lab between scheduled wakes. Neither heartbeat is a generic cron replacement.

## Facts
- `sulla chat/set_heartbeat '{"intervalMinutes":5}'` enables the current chat heartbeat; `intervalMinutes:0` disables it.
- A chat heartbeat can carry a custom `message`; omitting it preserves the current message or uses the default.
- A chat beat is delivered to the same thread and channel as a system-originated user message after a full idle interval.
- A running graph pauses the chat timer. When it stops, a new full interval starts and no held beat is delivered.
- The chat heartbeat tool also registers relay or background threads that have no open Desktop tab.
- Calling `set_heartbeat` is governed by the calling agent's own `config.heartbeat` (allowed, default/min/max interval minutes); an out-of-range interval is refused, and `intervalMinutes:0` is always allowed. This applies the same way whether the thread is a visible chat tab or a hidden background job — a human toggling heartbeat from a chat tab's own UI is not gated by this policy.
- A hidden job's heartbeat wakes that job's own agent on its own thread: a manager parked waiting on its children gets the beat delivered in place; a dormant parked job (e.g. after a restart) is woken fresh; a beat due while the agent is genuinely busy waits rather than interrupting it.
- A hidden job's heartbeat ends automatically the moment that job returns its result, is stopped, or fails — it never fires again afterward.
- The autonomous Heartbeat agent uses the `heartbeat` graph and channel, and follows the north star plus at most three measurable active goals.
- The autonomous agent records ideas, experiments, evidence, and verdicts in `Projects/heartbeat-idea-lab/` in Files.
- Message the autonomous agent with a channel message such as `<channel:heartbeat>Evidence and requested outcome.</channel:heartbeat>`.

## Rules
- DO: Enable the chat heartbeat in the same turn that background work begins. Why: it can recover a worker or job that later dies.
- PREFER: About 5 minutes while driving workers and about 30 minutes while waiting only on the human. Why: cadence should match the wait.
- DO: Make a real move on every wake and update the Playbook. Why: unchanged-status reports do not advance the goal.
- DO: Disable the chat heartbeat after the Playbook is final. Why: a finished goal needs no more wakes.
- DON'T: Confuse a thread's chat heartbeat with the autonomous Heartbeat agent. Why: they have different owners, scopes, and schedulers.
- DON'T: Use either heartbeat for exact-time recurrence. Use a scheduled Sulla Workflow instead. Why: workflows are the scheduling system.
