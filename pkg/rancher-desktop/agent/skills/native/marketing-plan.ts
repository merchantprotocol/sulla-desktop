import type { NativeSkillDefinition } from './NativeSkillRegistry';

const SKILL_DOC = `---
schemaversion: 1
slug: marketing-plan
title: "Full-Stack Marketing Plan"
section: "Standard Operating Procedures"
category: "Marketing"
tags:
  - skill
  - marketing
  - social-media
  - content
  - seo
  - email
  - communication
  - branding
  - ecommerce
related:
  - project-management
  - sales-development-outreach
  - lead-generation
  - facebook-ads
  - n8n-workflow-automations
order: 5
locked: true
author: seed
---

# Full-Stack Marketing Plan — Standard Operating Procedure

**Triggers**: Human says "marketing plan", "help with marketing", "market my business", "market my product", "social media marketing", "grow my brand", "content marketing", "marketing strategy", "promote my business", "ecommerce marketing", "digital marketing", "set up marketing".

## Overview

This skill orchestrates a complete marketing operation for a business, product, or e-commerce store. It is broken into three sequential phases. Each phase builds on the previous one. The agent creates a **marketing project** with structured markdown files for every deliverable.

---

## Phase 1: Account Setup & Brand Research

### 1.1 Create the Marketing Project

\`\`\`
create_workspace("marketing-{business-slug}")
\`\`\`

Write a \`PROJECT.md\` using the Full PRD template from the project-management skill. Then create the following file structure:

\`\`\`
marketing-{business-slug}/
├── PROJECT.md
├── README.md
├── research/
│   ├── ideal-customer-profile.md
│   ├── competitor-analysis.md
│   └── brand-voice.md
├── accounts/
│   ├── overview.md
│   ├── facebook.md
│   ├── instagram.md
│   ├── twitter-x.md
│   ├── linkedin.md
│   ├── tiktok.md
│   ├── youtube.md
│   ├── pinterest.md
│   ├── google-business.md
│   └── {additional-platform}.md
├── groups/
│   ├── overview.md
│   ├── {group-name}.md
│   ├── listening-log.md
│   └── group-posts/
├── content/
│   ├── content-calendar.md
│   ├── blog-posts/
│   ├── social-posts/
│   ├── group-posts/
│   ├── images/
│   └── video/
├── communication/
│   ├── overview.md
│   ├── email-newsletter.md
│   ├── push-notifications.md
│   ├── sms.md
│   └── chat-channels.md
└── seo/
    ├── keyword-research.md
    ├── on-page-audit.md
    └── backlink-strategy.md
\`\`\`

### 1.2 Ideal Customer Profile Research

Create \`research/ideal-customer-profile.md\` containing:

- **Demographics** — age, gender, location, income, education, occupation
- **Psychographics** — values, interests, pain points, motivations, aspirations
- **Buying behavior** — where they shop, how they discover products, price sensitivity, decision triggers
- **Online behavior** — which platforms they use, content they engage with, time of day they are active
- **Customer segments** — 2-4 distinct personas with names, descriptions, and priorities

Use web search tools to research the industry, competitors, and audience data. Ask the human clarifying questions if the business type or target audience is unclear.

### 1.3 Competitor Analysis

Create \`research/competitor-analysis.md\` containing:

- Top 3-5 competitors identified via web search
- Their social media presence (which platforms, follower counts, posting frequency)
- Their content strategy (types of content, tone, engagement levels)
- Their strengths and weaknesses
- Opportunities for differentiation

### 1.4 Brand Voice

Create \`research/brand-voice.md\` containing:

- Tone (e.g., professional, casual, playful, authoritative)
- Key messaging pillars (3-5 core themes the brand talks about)
- Do's and don'ts for communication style
- Example phrases and taglines

### 1.5 Social Account Inventory & Setup

Create \`accounts/overview.md\` with a master table:

| Platform | Status | URL | Username | Priority | Notes |
|----------|--------|-----|----------|----------|-------|
| Facebook | needs-setup | — | — | high | ... |
| Instagram | active | url | @handle | high | ... |
| ... | ... | ... | ... | ... | ... |

For **each** platform, create a dedicated file (e.g., \`accounts/instagram.md\`) containing:

- **Profile name / display name** — optimized for search and brand recognition
- **Bio / description** — written using brand voice, includes keywords and CTA
- **Profile image** — recommendation (logo, headshot, etc.)
- **Cover / banner image** — recommendation with dimensions
- **Link in bio** — recommended URL (website, Linktree, etc.)
- **Category / business type** — platform-specific category selection
- **Contact info** — email, phone, address if applicable
- **Hashtag strategy** — 10-20 recommended hashtags for this platform
- **Posting schedule** — recommended frequency and best times based on ICP research
- **Content pillars** — what types of content to post here

### 1.6 Community Group Discovery & Listening

One of the most effective marketing strategies is finding the online groups and communities where your ideal customer profile congregates — Facebook Groups, Reddit subreddits, LinkedIn Groups, Discord servers, Slack communities, forums, etc.

Create \`groups/overview.md\` with a master table:

| Group Name | Platform | URL | Members | Activity Level | Joined | Monitoring |
|------------|----------|-----|---------|---------------|--------|------------|
| {name} | Facebook | url | ~5k | high | yes/no | active/pending |
| r/{sub} | Reddit | url | ~50k | medium | yes/no | active/pending |
| ... | ... | ... | ... | ... | ... | ... |

#### How to find groups
- Search each platform from the ICP research for groups related to the business niche
- Use web search: \"{industry} + facebook group\", \"{niche} + reddit\", \"{topic} + discord community\"
- Look at where competitors are active and engaged
- Check the ICP's online behavior — which communities did research identify?
- Aim for 5-15 relevant groups across platforms

#### For each group, create a dedicated file (e.g., \`groups/{group-slug}.md\`) containing:

- **Group name and URL**
- **Platform** (Facebook, Reddit, LinkedIn, Discord, etc.)
- **Member count and activity level**
- **Group rules** — posting guidelines, self-promotion rules, link policies
- **Key topics discussed** — recurring themes, popular threads, FAQ
- **Pain points expressed** — what members complain about, ask for help with, struggle with
- **Content gaps** — topics members want to learn about but nobody is answering well
- **Influencers / active members** — who are the top contributors and moderators
- **Posting strategy** — what type of content performs well here, best times to post, tone

#### Listening Log

Create \`groups/listening-log.md\` — an ongoing log of observations:

\`\`\`
## Listening Log

### YYYY-MM-DD — {Group Name}
- **Hot topic**: {what people are talking about}
- **Question asked**: \"{direct quote or paraphrase}\"
- **Pain point**: {what they are struggling with}
- **Content opportunity**: {article/post idea that would help them}
- **Engagement note**: {what type of posts get the most replies/likes}
\`\`\`

This log feeds directly into Phase 2 content production. Every content opportunity identified here becomes a candidate for the content calendar.

#### Monitoring Automation

Use n8n to set up monitoring workflows where possible:
- **RSS feeds** for Reddit subreddits and forums
- **Web scraping** for group post summaries (where ToS allows)
- **Keyword alerts** for brand mentions and niche topics
- Load the \`n8n-workflow-automations\` skill to build these monitoring pipelines

### 1.7 Integration Connections

Check which integrations are available and connected:

\`\`\`
integration_is_enabled({ integration_slug: "postiz" })
integration_is_enabled({ integration_slug: "chatwoot" })
\`\`\`

For social platforms that support OAuth integration, guide the human through connecting their accounts:

\`\`\`
integration_get_credentials({ integration_slug: "<platform>" })
\`\`\`

If an integration requires OAuth, walk the human through the connection flow. Document connection status in \`accounts/overview.md\`.

### 1.8 Website Assessment

If the business has an existing website:
- Review it using browser/playwright tools if available
- Note what needs improvement (SEO, messaging, design, CTA placement)
- Document findings in \`seo/on-page-audit.md\`

If the business needs a new website:
- Flag this as a separate project dependency
- Load the \`new-software-development-project\` skill for website creation
- Add website creation to the marketing project checklist

### Phase 1 Deliverables
- [ ] Marketing project created with full directory structure
- [ ] Ideal customer profile researched and documented
- [ ] Competitor analysis completed
- [ ] Brand voice guide created
- [ ] All social accounts inventoried with individual profile files
- [ ] Profile descriptions, bios, and hashtag strategies written for each platform
- [ ] Community groups discovered and documented (5-15 groups)
- [ ] Listening log started with initial observations from each group
- [ ] Group monitoring automations set up where possible
- [ ] Integration connections established where possible
- [ ] Website reviewed or flagged for creation

---

## Phase 2: Content Production

### 2.1 Content Calendar

Create \`content/content-calendar.md\` with a rolling 30-day plan:

- **Week-by-week breakdown** of content themes aligned with brand pillars
- **Platform-specific posts** — each post tagged with platform, format, and publish date
- **Content mix** — educational (40%), entertaining (30%), promotional (20%), community (10%)
- **Key dates** — holidays, industry events, product launches, seasonal trends
- **Group content schedule** — which group posts go out on which days, sourced from listening log

### 2.2 Content Strategy: Two Distinct Voices

All content production follows a **dual-track strategy** based on where the content is published:

#### Track A: Group Content (Educational / DIY)
Content posted into community groups where the ICP congregates. This content is:
- **Purely helpful** — teaches people how to solve their problems themselves
- **No selling** — no links to products, no CTAs to buy, no self-promotion
- **Research-driven** — topics come directly from the groups/listening-log.md observations
- **Tone**: peer-to-peer, generous, expert sharing knowledge freely
- **Format**: how-to guides, step-by-step tutorials, answers to common questions, tips and tricks, resource lists
- **Goal**: build authority, trust, and name recognition within the community

Store group content in \`content/group-posts/\` organized by group:
\`\`\`
content/group-posts/
├── {group-slug}/
│   ├── post-001-how-to-{topic}.md
│   ├── post-002-guide-to-{topic}.md
│   └── ...
\`\`\`

Each group post file contains:
- **Target group** and its rules/constraints
- **Topic** sourced from listening log (link to the observation)
- **Full post text** written in the group's expected tone
- **Publish date** and status (draft/published/scheduled)

#### Track B: Social Profile Content (Solution-Based)
Content posted to the business's own social profiles (Instagram, Twitter, LinkedIn, YouTube, etc.). This content is:
- **Solution-oriented** — showcases what the business has built, the results it delivers, the problems it solves
- **Brand-forward** — uses brand voice, includes CTAs, links to website/products
- **Tone**: authoritative, confident, "we have built the solution"
- **Format**: case studies, before/after, product demos, testimonials, behind-the-scenes, transformation stories
- **Goal**: convert awareness into leads, followers, and customers

Store social profile content in \`content/social-posts/\` organized by platform:
\`\`\`
content/social-posts/
├── instagram/
├── twitter/
├── linkedin/
├── tiktok/
└── ...
\`\`\`

Each social post includes: copy, hashtags, CTA, suggested publish time.

#### The Flywheel
The two tracks feed each other:
1. **Listen** in groups → identify pain points and questions from the listening log
2. **Research and write** educational group content that answers those questions
3. **Post** the educational content into the groups (Track A)
4. **Repurpose** the same topic into solution-based content for social profiles (Track B) — same problem, but framed as "here is the solution we built"
5. **Repeat** — the group listening continuously feeds new content ideas

### 2.3 Text-Based Content (Start Here)

Begin with the easiest content type:

#### Blog Posts / Articles
- Create outlines in \`content/blog-posts/\`
- Each post file contains: title, target keywords, outline, draft, meta description
- SEO-optimized using keyword research from \`seo/keyword-research.md\`
- Aim for 3-5 pillar articles to start
- Blog posts can serve both tracks — long-form educational content shared in groups, and solution-based posts linked from social profiles

#### Group Posts (Track A — Priority)
- Review \`groups/listening-log.md\` for content opportunities
- For each opportunity, research the topic thoroughly using web search
- Write a comprehensive, helpful post that answers the question or solves the problem
- Follow each group's posting rules exactly — violating rules gets the account banned
- Create 1-2 group posts per week per active group

#### Social Media Posts (Track B)
- Create platform-specific post batches in \`content/social-posts/\`
- Organize by platform: \`content/social-posts/instagram/\`, \`content/social-posts/twitter/\`, etc.
- Each post includes: copy, hashtags, CTA, suggested publish time
- Create 2-4 weeks of posts upfront

### 2.4 SEO Strategy

Create \`seo/keyword-research.md\`:
- Primary keywords (5-10 high-intent terms)
- Long-tail keywords (20-30 specific phrases)
- Keyword difficulty and search volume estimates
- Content mapping — which keyword maps to which page/post

Create \`seo/backlink-strategy.md\`:
- Target websites for guest posts or mentions
- Link-building tactics appropriate for the business
- Internal linking strategy for the website

### 2.5 Image Content

- Use available image generation tools or guide the human on creating branded visuals
- Create image templates/guidelines in \`content/images/\`
- Cover: social post images, story templates, ad creatives, infographics

### 2.6 Video Content

- Create video content briefs in \`content/video/\`
- Short-form (Reels, TikTok, Shorts) — scripts and shot lists
- Long-form (YouTube) — outlines and scripts
- If Remotion is available, load the \`remotion-video-generator\` skill for automated video creation

### 2.7 Content Management Software

Check and install content management extensions:

\`\`\`
integration_is_enabled({ integration_slug: "postiz" })
\`\`\`

**Postiz** — Social media scheduling and management platform. If not installed:
- Guide the human to install it from the Extensions marketplace
- Once installed, configure it to connect to their social accounts
- Set up scheduled posting based on the content calendar

Other content tools to check:
- **WordPress** — for blog/website content management
- **Remotion** — for programmatic video generation

### Phase 2 Deliverables
- [ ] Content calendar created (30-day rolling plan) including group posting schedule
- [ ] Listening log reviewed and content opportunities prioritized
- [ ] Group posts written for active communities (Track A — educational/DIY)
- [ ] Social profile posts batched for 2-4 weeks (Track B — solution-based)
- [ ] SEO keyword research completed
- [ ] Blog post outlines and drafts created
- [ ] Image guidelines and templates created
- [ ] Video content briefs written
- [ ] Postiz or equivalent content scheduler configured
- [ ] On-page SEO audit documented
- [ ] Backlink strategy documented

---

## Phase 3: Communication Pipelines

### 3.1 Unified Chat Management

**Chatwoot** — Omnichannel customer communication platform. Check status:

\`\`\`
integration_is_enabled({ integration_slug: "chatwoot" })
\`\`\`

If not installed, guide the human to install from Extensions marketplace. Then configure:
- Connect each social media account as an inbox (Facebook, Instagram, Twitter, WhatsApp, Telegram, etc.)
- Set up auto-assignment rules
- Configure canned responses for common questions
- Set business hours and away messages
- Set up team inboxes if multiple people handle communications

Document the setup in \`communication/chat-channels.md\`.

### 3.2 Email Newsletter System

Create \`communication/email-newsletter.md\` with:
- Recommended email platform (Mautic if self-hosted via Extensions, or external like Mailchimp)
- List building strategy (lead magnets, opt-in forms, popups)
- Welcome email sequence (3-5 emails for new subscribers)
- Newsletter cadence (weekly/biweekly/monthly)
- Newsletter template structure
- Segmentation strategy based on ICP

Check for available email tools:
\`\`\`
integration_is_enabled({ integration_slug: "mautic" })
\`\`\`

If Mautic is available, configure:
- Contact lists and segments
- Email templates
- Automation workflows for welcome sequences
- Opt-in forms

### 3.3 Push Notifications

Create \`communication/push-notifications.md\` with:
- Recommended push notification service
- Opt-in strategy and timing
- Notification types (promotional, transactional, re-engagement)
- Frequency limits to avoid unsubscribes

### 3.4 SMS Marketing

Create \`communication/sms.md\` with:
- Recommended SMS platform
- Compliance requirements (opt-in, opt-out, TCPA/GDPR)
- Use cases (order updates, promotions, abandoned cart)
- Message templates

### 3.5 Automation Workflows

Use n8n to wire up communication automations. Load the \`n8n-workflow-automations\` skill for building:
- **New follower welcome** — auto-DM or email when someone follows
- **Lead capture** — form submission → email sequence + CRM
- **Content distribution** — auto-post across platforms when new content is published
- **Review monitoring** — alert on new reviews across platforms
- **Abandoned cart recovery** — email/SMS sequence for e-commerce
- **Social listening** — monitor brand mentions and route to Chatwoot

### 3.6 Notification System (Novu)

Check for Novu (multi-channel notification infrastructure):
\`\`\`
integration_is_enabled({ integration_slug: "novu" })
\`\`\`

If available, configure as the central notification router for email, SMS, push, and in-app notifications.

### Phase 3 Deliverables
- [ ] Chatwoot installed and configured with social inboxes
- [ ] Email newsletter system set up (Mautic or alternative)
- [ ] Welcome email sequence drafted
- [ ] Push notification strategy documented
- [ ] SMS marketing plan documented
- [ ] n8n automation workflows created for key pipelines
- [ ] All communication channels documented in communication/overview.md

---

## Available Extensions for Marketing

These are installable from the Extensions marketplace if not already set up:

| Extension | Purpose | Category |
|-----------|---------|----------|
| **Postiz** | Social media scheduling, publishing, analytics | Content |
| **Chatwoot** | Omnichannel chat, social inbox, customer support | Communication |
| **Mautic** | Email marketing automation, lead nurturing | Communication |
| **Novu** | Multi-channel notification infrastructure | Communication |
| **WordPress** | Website, blog, CMS | Content / SEO |
| **Remotion** | Programmatic video generation | Content |
| **n8n** | Workflow automation connecting all the above | Automation |
| **ERPNext** | CRM, e-commerce, inventory (if applicable) | Operations |

---

## Execution Order

1. **Always start with Phase 1** — you cannot produce content without knowing who you are talking to
2. **Phase 2 starts text-first** — text content is fastest to produce, then images, then video
3. **Phase 3 can begin in parallel with Phase 2** — communication pipelines can be set up while content is being produced
4. **Iterate continuously** — revisit the ICP and content calendar monthly

## Integration Tools

\`\`\`
integration_is_enabled({ integration_slug: "<slug>" })
integration_get_credentials({ integration_slug: "<slug>", include_secrets: true })
\`\`\`

Use these to check connection status and retrieve credentials for any platform. If OAuth is required, guide the human through the connection flow.

## Project Management

This is a **Large** project. Use the Full PRD template (Tier 3) from the project-management skill. Keep PROJECT.md updated as phases are completed. Add to ACTIVE_PROJECTS.md.
`;

export const marketingPlanSkill: NativeSkillDefinition = {
  name: 'marketing-plan',
  description: 'Full-stack marketing plan for businesses, products, or e-commerce stores — covers account setup, ICP research, content production (text/image/video), SEO, and communication pipelines (social, email, SMS, push).',
  tags: ['marketing', 'social-media', 'content', 'seo', 'email', 'ecommerce', 'branding', 'postiz', 'chatwoot', 'newsletter', 'advertising', 'growth'],
  version: '1.0',
  async func() {
    return SKILL_DOC;
  },
};
