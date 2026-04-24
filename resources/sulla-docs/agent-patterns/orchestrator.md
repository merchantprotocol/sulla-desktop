# Agent Patterns — Writing Orchestrator Instructions

## What the Agent Receives

When a workflow node executes, the agent receives:

1. **`orchestratorInstructions`** — template-resolved, sent as the primary directive
2. **Upstream context** — all prior node outputs, labeled:
   ```
   [Node Label]: <output text or JSON>
   [Another Node]: <output>
   ```
3. **Trigger payload** — original input that started the workflow (if no other context)

---

## Writing Good Instructions

**Be explicit about the task, inputs, and exit condition:**
```yaml
orchestratorInstructions: |
  You are writing a LinkedIn post for Merchant Protocol / Sulla Desktop.
  
  Audience profile: {{Load Context}}
  Today's date: run exec `date +%Y-%m-%d`
  
  Write ONE LinkedIn post (150-300 words) following this structure:
  1. Hook (one bold line, no "I'm excited to share")
  2. Problem paragraph (make them feel seen)
  3. Transformation paragraph (Sulla Desktop as the shift)
  4. CTA (soft, genuine question)
  5. 3-5 hashtags at the bottom
  
  After writing, save it:
  exec `mkdir -p ~/sulla/content && cat > ~/sulla/content/linkedin-today.md << 'EOF'
  [your post here]
  EOF`
  
  Return the post text as your output.
```

**Use templates to inject upstream data:**
- `{{trigger}}` — what started the workflow
- `{{Node Label}}` — output from a named upstream node
- Keep node labels stable — renaming them breaks template references

---

## successCriteria

Metadata field — describes what "done" looks like. The system doesn't actively validate it; you write it for documentation and your own clarity.

```yaml
successCriteria: "LinkedIn post 150-300 words, saved to ~/sulla/content/"
```

---

## completionContract

Tells the agent which XML wrapper to use when finishing. In practice, the AgentNode system prompt already handles this — you don't need to repeat the full wrapper spec. One line is enough:

```yaml
completionContract: "Exit when post is written and saved"
```

The agent must wrap its final response in `<AGENT_DONE>`, `<AGENT_BLOCKED>`, or `<AGENT_CONTINUE>`.

---

## Agent Completion Wrappers

Every agent turn must end with exactly ONE of:

```
<AGENT_DONE>
[1-3 sentence summary of what was accomplished]
Needs user input: [yes/no]
</AGENT_DONE>
```

```
<AGENT_BLOCKED>
<BLOCKER_REASON>[one-line blocker]</BLOCKER_REASON>
<UNBLOCK_REQUIREMENTS>[what is needed to proceed]</UNBLOCK_REQUIREMENTS>
</AGENT_BLOCKED>
```

```
<AGENT_CONTINUE>
<STATUS_REPORT>[one-line: what you are actively working on now]</STATUS_REPORT>
</AGENT_CONTINUE>
```

---

## Common Patterns

### Read a file, process, write output
```yaml
orchestratorInstructions: |
  Read ~/sulla/identity/business/identity.md
  Extract: target customer, their pain points, the transformation promised.
  Write a structured JSON summary to ~/sulla/cache/icp.json
  Return the JSON as your output.
```

### Call a tool and use the result
```yaml
orchestratorInstructions: |
  Run: exec `sulla function/function_run '{"slug":"social-cache-read","inputs":{"max_age_days":7}}'`
  If needs_refresh is true: [do fresh research]
  If needs_refresh is false: use the cache as-is.
  Return the audience profile object.
```

### Parallel content generation
```yaml
orchestratorInstructions: |
  Using the ICP profile from {{Load Context}}, write ONE Twitter post.
  Rules:
  - Max 280 characters (count carefully)
  - Lead with pain state (BEFORE), reveal transformation (AFTER)
  - Name Sulla Desktop once as the bridge
  - 2-3 hashtags
  Output ONLY the post text. No labels, no quotes.
```
