---
slug: sulla-ask-the-human
label: Ask the human for a decision
trigger_when: When a real user choice, credential, approval, or irreversible action blocks progress.
trigger_actions: [ask a question, request approval, need credentials, need a choice]
trigger_phrases: [ask me, need approval, which option, I need your decision, option A or B, pick with me, before you go on, which one should we, let me choose]
scope: [sulla-chat]
---

**When:** You cannot safely choose or proceed without the human.

**Do:**
1. Ask one focused question with the smallest useful set of choices.
2. Use `sulla meta/ask_user_question '{"questions":[{"header":"Decision","question":"<question>","options":[{"label":"<choice>","description":"<impact>"},{"label":"<choice>","description":"<impact>"}]}]}'` (under Claude Code, the `mcp__sulla-native__ask_user_question` tool takes the same `questions` array) when an interactive answer is needed.
3. End the reply with `<AGENT_BLOCKED>` naming the exact blocker and required input.

**Don't:**
- Ask for approval for a reversible action you can safely execute.
- send, post, pay, delete, or expose secrets without the human's tap.
