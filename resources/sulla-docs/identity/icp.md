# Identity System — ICP & Content Generation

## Finding the ICP

The Ideal Customer Profile lives in:
- `~/sulla/identity/business/identity.md` — product state, market position, customer type
- `~/sulla/identity/business/goals.md` — transformation arc, what success looks like
- `~/sulla/identity/business/marketing.md` — audience framing, value props, content strategy

Always read these files fresh rather than relying on cached assumptions. Business positioning evolves.

---

## Current Product Positioning (as of 2026-04-23)

**Product:** Sulla Desktop — AI executive assistant that runs autonomous agents.

**Target customer:** Solopreneurs, indie founders, and tech-forward small business owners (1-10 person teams).

**The transformation they want:**
- BEFORE: Overwhelmed operator doing everything themselves. Too many tools, not enough hours. Working nights and weekends. Can't scale without hiring people they can't afford.
- AFTER: Autonomous CEO. AI agents execute the work. They handle vision and strategy.

**Key pain points:**
1. Too many tools, not enough time
2. Doing repetitive work that should be automated
3. Can't scale without hiring
4. Working nights and weekends on tasks that don't move the needle
5. Competitors using AI are moving faster

**Language patterns (use these in copy):**
- "I can't keep up"
- "I'm the bottleneck in my own business"
- "I need to clone myself"
- "I just want to focus on what I'm good at"
- "I need systems that work while I sleep"

**Product differentiators:**
- Free to download — real value without a paywall
- Runs autonomous agents that execute tasks without being asked
- Cloud relay — agents keep working even when laptop is off
- Threat-proxy URL filtering for secure browsing
- MCP native bridge — agents can trigger any workflow
- Not just chat — near-full execution autonomy on real tasks

**CTAs:**
- Primary: "Download free at merchantprotocol.com"
- Support tier: $19/mo Premium Support
- Enterprise: $99/mo Enterprise Gateway

---

## Content Framing Arc

Every piece of content follows this arc:

```
Pain (they feel this) → Transformation (they want this) → Sulla Desktop (the bridge)
```

**DO:**
- Lead with the BEFORE state — their daily frustration
- Make them feel seen and understood
- Position Sulla Desktop as the shift, not as software
- Use concrete outcomes, not feature lists
- "93% of our own commits are AI-executed — we dogfood this"

**DON'T:**
- List features without emotional context
- Lead with the product name
- Use corporate or salesy language
- Be vague about the transformation

---

## ICP Cache Pattern

For daily content generation, cache the ICP to avoid re-reading files every run:

```bash
# Check cache freshness
exec({ command: "sulla function/function_run '{\"slug\":\"social-cache-read\",\"inputs\":{\"max_age_days\":7}}'" })

# If needs_refresh, read identity files and synthesize fresh cache
exec({ command: "cat ~/sulla/identity/business/identity.md ~/sulla/identity/business/goals.md ~/sulla/identity/business/marketing.md" })

# Write fresh cache
exec({ command: "sulla function/function_run '{\"slug\":\"social-cache-write\",\"inputs\":{\"cache_data\":{...}}}'" })
```

Cache lives at: `~/sulla/workflows/social-media-posts/audience-cache.json`

---

## Post Angles (Social Media)

Rotate through these — don't repeat the same angle within 7 days:

- **Pain angles:** tool overload, you're the bottleneck, working nights, competitors moving faster, can't scale without hiring
- **Transformation angles:** agents run your business while you sleep, stop being the operator/become the owner, your to-do list has a team
- **Social proof:** 93% AI-executed commits, built by a solopreneur for solopreneurs, dogfooded daily
- **Feature angles:** cloud relay, free to start, MCP bridge
- **Hook questions:** "What would you do with 20 extra hours per week?"
