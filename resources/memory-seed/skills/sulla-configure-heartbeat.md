---
slug: sulla-configure-heartbeat
label: Keep a chat awake with its heartbeat
trigger_when: When you are starting background work, driving workers or jobs, waiting for a result, or need the current chat to wake itself and keep work moving.
trigger_actions: [turn on chat heartbeat, monitor background work, wake this chat, turn off chat heartbeat]
trigger_phrases: [keep working in the background, check on the workers, wake this chat, chat heartbeat, set heartbeat]
scope: [sulla-heartbeat, sulla-chat]
---

**When:** Use the chat heartbeat for an unfinished goal that must survive an idle chat. It belongs to this chat and is separate from the always-running Heartbeat agent.

**Do:**
1. Turn it on in the same turn that background work starts. Give the wake a concrete engine-check message:
   `sulla chat/set_heartbeat '{"intervalMinutes":5,"message":"Check every running worker and job. If one died or stalled, recover or relaunch it. Verify returned work, update the Playbook, and make the next real move. Never report only that nothing changed."}'`
2. Match the interval to the wait. Use about 5 minutes while actively driving workers or jobs. Use about 30 minutes when only the human can supply the next input:
   `sulla chat/set_heartbeat '{"intervalMinutes":30,"message":"Check whether the human supplied the needed input. If not, make any other useful reversible move on this goal and do not post an unchanged-status report."}'`
3. On every wake, inspect the real state and act. Recover dead work, verify results, unblock the next chunk, or do another useful step. Update the goal's Playbook after the move.
4. Keep it on while any Playbook chunk is open. If finished work gains new scope, turn it on again.
5. Finalize the Playbook, then turn the chat heartbeat off:
   `sulla chat/set_heartbeat '{"intervalMinutes":0}'`
6. Check the tool response. It says either that this chat's heartbeat is on at the requested interval or that it is off.

**How it wakes:** The tool registers the current thread and channel. After the chat has been idle for a full interval, it delivers the configured text back to the same thread as a system-originated user message. A running graph pauses the timer. When the graph stops, a fresh full interval begins; no overdue beat is held.

**Always-running Heartbeat agent:** This is a different agent with the `heartbeat` channel. It wakes on its own scheduler to pursue its north star, run reversible experiments, and maintain its idea lab. Message it only when that autonomous lane needs evidence or a systemic concern: `<channel:heartbeat>Concise evidence and requested outcome.</channel:heartbeat>`. Use the chat heartbeat, not that agent, to supervise this chat's goal.

**Don't:**
- Don't enable the global Heartbeat agent settings to keep one chat alive.
- Don't wait for the first idle interval before starting work.
- Don't leave the chat heartbeat on after the goal is complete.
- Don't spend a wake saying “nothing changed.” Change approach or make another real move.
