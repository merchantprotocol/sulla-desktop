import type { NativeSkillDefinition } from './NativeSkillRegistry';

const SKILL_DOC = `---
schemaversion: 1
slug: sales-development-outreach
title: "Sales Development & Outreach Plan"
section: "Standard Operating Procedures"
category: "Sales"
tags:
  - skill
  - sales
  - outreach
  - crm
  - dream-100
  - influencer
  - podcast
  - cold-email
  - networking
related:
  - project-management
  - marketing-plan
  - lead-generation
  - facebook-ads
  - n8n-workflow-automations
order: 6
locked: true
author: seed
---

# Sales Development & Outreach Plan — Standard Operating Procedure

**Triggers**: Human says "sales outreach", "outreach plan", "dream 100", "cold outreach", "sales development", "find leads", "influencer outreach", "podcast outreach", "network growth", "cold email campaign", "mass outreach", "build pipeline", "lead generation", "sales plan", "outbound sales".

## Overview

This skill sets up and executes a complete sales development outreach operation. It is designed to run after or alongside the marketing plan skill, but can also be started independently. The agent creates a **sales outreach project** with structured markdown files for every outreach category, CRM records, and campaign configurations.

There are two layers to this plan:
1. **Targeted Outreach** — Research-driven, relationship-first outreach to specific high-value individuals (Dream 100, Influencers, Podcasts, Network Growth)
2. **Mass Outreach** — Volume-based campaigns across channels (cold email, SMS, social DMs), starting with lowest risk and scaling up

---

## Project Setup

### Create the Sales Outreach Project

\`\`\`
create_workspace("sales-outreach-{business-slug}")
\`\`\`

Write a \`PROJECT.md\` using the Full PRD template from the project-management skill. Then create the following file structure:

\`\`\`
sales-outreach-{business-slug}/
├── PROJECT.md
├── README.md
├── research/
│   ├── ideal-customer-profile.md
│   └── industry-referral-map.md
├── dream-100/
│   ├── overview.md
│   ├── {company-slug}.md
│   └── outreach-log.md
├── influencers/
│   ├── overview.md
│   ├── {influencer-slug}.md
│   └── outreach-log.md
├── podcasts/
│   ├── overview.md
│   ├── {podcast-slug}.md
│   └── outreach-log.md
├── network-growth/
│   ├── overview.md
│   ├── {contact-slug}.md
│   └── outreach-log.md
├── mass-outreach/
│   ├── overview.md
│   ├── cold-email/
│   │   ├── setup.md
│   │   ├── sequences/
│   │   └── lists/
│   ├── sms/
│   │   ├── setup.md
│   │   └── sequences/
│   └── social-dm/
│       ├── setup.md
│       └── sequences/
├── email-templates/
│   ├── dream-100-intro.md
│   ├── influencer-collab.md
│   ├── podcast-pitch.md
│   ├── network-coffee-invite.md
│   └── follow-up-sequences/
└── crm/
    └── setup.md
\`\`\`

### CRM Setup (Twenty CRM)

The CRM is the central hub for all outreach. Check and install Twenty CRM:

\`\`\`
integration_is_enabled({ integration_slug: "twenty" })
\`\`\`

If not installed, guide the human to install it from the Extensions marketplace. Then configure:

- **Custom categories/tags** for each outreach type:
  - \`dream-100\` — High-value ideal clients (big companies you want to work with)
  - \`influencer\` — People with audiences relevant to your ICP
  - \`podcast\` — Shows that speak to your audience
  - \`network-referral\` — Key referral sources in the industry
  - \`mass-outreach-lead\` — Volume leads from list building
- **Custom fields** for tracking:
  - Outreach status (researching / contacted / replied / meeting-scheduled / relationship-active)
  - Contact method (email / DM / phone / in-person)
  - Last contact date
  - Notes / conversation history
  - Source category

Document the CRM setup in \`crm/setup.md\`.

Every contact profiled in this plan gets added to Twenty CRM with the appropriate category.

---

## Phase 1: Targeted Outreach — Research & Profiling

### 1.1 Dream 100

The Dream 100 is a curated list of the top ideal clients — big companies or individuals you would most want to do business with. These are high-value targets where you invest significant time in research and relationship building.

**The rule: NO offers. NO pitching. The goal is to build a genuine relationship.**

Create \`dream-100/overview.md\` with a master table:

| Company / Person | Industry | Why They're Ideal | Contact Person | Status | Last Contact |
|------------------|----------|-------------------|---------------|--------|-------------|
| {name} | {industry} | {reason} | {name, title} | researching | — |
| ... | ... | ... | ... | ... | ... |

#### How to identify the Dream 100
- Review the ICP from the marketing project (if it exists) or create \`research/ideal-customer-profile.md\`
- Use web search to find the top companies in the target industry/niche
- Look at the business's existing best customers — find more like them but bigger
- Check competitor client lists, case studies, testimonials
- Search LinkedIn for decision-makers at target companies
- Aim for exactly 100 targets (can start with 25-50 and grow)

#### For each Dream 100 target, create a dedicated file (e.g., \`dream-100/{company-slug}.md\`) containing:

- **Company name and website**
- **What they do** — products, services, market position
- **Why they're ideal** — alignment with our offering, size, potential deal value
- **Key decision maker(s)** — name, title, LinkedIn, email
- **Their pain points** — what challenges they likely face that we can help with
- **Recent news / activity** — press releases, blog posts, social media activity, funding rounds
- **Common ground** — mutual connections, shared interests, events attended
- **Outreach angle** — the conversation starter, NOT a pitch (e.g., congratulate on recent achievement, share relevant insight, ask for advice)
- **Contact info** — email, LinkedIn, Twitter, phone if available

#### Dream 100 Outreach Strategy
1. **Research deeply** before any contact — know their business, their challenges, their recent wins
2. **Warm up** — engage with their content on social media (like, comment thoughtfully, share)
3. **First touch** — send a personalized email or LinkedIn message that is purely relationship-focused
4. **Follow up** — provide value (share an article, make an introduction, offer a genuine compliment)
5. **Goal**: get a coffee meeting, a phone call, or a Zoom — just a conversation, not a sale
6. **Long game** — this is a 3-12 month relationship-building process

Add every Dream 100 contact to Twenty CRM with category \`dream-100\`.

### 1.2 Influencer Outreach

Identify people who have an audience that matches your ICP. The goal is to figure out how you can help the influencer serve their audience better.

Create \`influencers/overview.md\` with a master table:

| Influencer | Platform | Audience Size | Niche | Audience Overlap | Status | Last Contact |
|-----------|----------|--------------|-------|-----------------|--------|-------------|
| {name} | YouTube | ~100k | {niche} | high | researching | — |
| {name} | Instagram | ~50k | {niche} | medium | contacted | 2026-03-01 |
| ... | ... | ... | ... | ... | ... | ... |

#### How to identify influencers
- Search each major platform (YouTube, Instagram, TikTok, Twitter, LinkedIn) for creators in the niche
- Use web search: "{industry} influencers", "{niche} content creators", "top {topic} YouTubers"
- Look at who the ICP follows and engages with
- Check competitor brand partnerships and sponsorships
- Aim for 20-50 influencers across tiers (micro: 5k-50k, mid: 50k-500k, macro: 500k+)

#### For each influencer, create a dedicated file (e.g., \`influencers/{influencer-slug}.md\`) containing:

- **Name and handles** across all platforms
- **Primary platform** and audience size
- **Content niche** — what topics they cover
- **Audience demographics** — who watches/follows them (overlap with our ICP?)
- **Content style** — educational, entertaining, review-based, lifestyle
- **Engagement rate** — comments, likes relative to followers
- **Topics their audience wants** — what questions appear in their comments, what videos perform best
- **How we can help them** — what can we offer that serves their audience? (free product, exclusive content, co-created resource, sponsorship)
- **Collaboration angle** — the specific pitch: "Your audience has been asking about X, and we've built Y that addresses exactly that"
- **Contact info** — email (often in bio), DM, management contact

#### Influencer Outreach Strategy
1. **Follow and engage** genuinely with their content for 1-2 weeks before reaching out
2. **Research their audience** — read comments, identify what their followers want
3. **Craft value-first pitch** — lead with how you can help their audience, not what you want from them
4. **Offer something concrete** — free product to review, co-hosted content, exclusive for their audience
5. **Make it easy** — provide all assets, talking points, and content they'd need

Add every influencer to Twenty CRM with category \`influencer\`.

### 1.3 Podcast Outreach

Identify podcasts whose audience matches your ICP. The goal is to become a guest on these shows by offering topics their audience wants to hear.

Create \`podcasts/overview.md\` with a master table:

| Podcast | Host | Platform | Audience Size | Niche | Guest-Friendly | Status | Last Contact |
|---------|------|----------|--------------|-------|---------------|--------|-------------|
| {name} | {host} | Apple/Spotify | ~10k/ep | {niche} | yes | researching | — |
| ... | ... | ... | ... | ... | ... | ... | ... |

#### How to identify podcasts
- Search Apple Podcasts, Spotify, and Google for shows in the niche
- Use web search: "{industry} podcast", "best {niche} podcasts", "{topic} podcast guest"
- Check podcast directories like ListenNotes, Podchaser
- Look at what podcasts competitors have appeared on
- Check if target influencers or Dream 100 contacts have podcasts
- Aim for 25-50 podcasts across sizes

#### For each podcast, create a dedicated file (e.g., \`podcasts/{podcast-slug}.md\`) containing:

- **Podcast name and links** (Apple, Spotify, website)
- **Host name(s)** and contact info
- **Episode count and cadence** — weekly, biweekly, etc.
- **Audience size** — downloads per episode if available, review count as proxy
- **Niche and topics covered** — what do they talk about
- **Guest format** — do they have guests? Interview style? Panel?
- **Recent episodes** — titles of last 5-10 episodes to understand current topics
- **Topics their audience enjoys** — based on episode popularity, comments, reviews
- **Our pitch topics** — 2-3 specific topics we could speak on that would resonate with their audience
- **Booking process** — do they have a guest application form, booking email, or do you DM the host?
- **Contact info** — email, social handles, booking link

#### Podcast Outreach Strategy
1. **Listen to 2-3 episodes** before reaching out — reference specific episodes in your pitch
2. **Identify topic gaps** — what hasn't been covered that their audience would love?
3. **Craft a guest pitch** — "I noticed your audience loved episode X about Y. I have a unique angle on Z that I think would be a great follow-up" 
4. **Provide ready-to-go topics** — give the host 2-3 topic options with bullet points of what you'd cover
5. **Include social proof** — other podcasts you've been on, your expertise, your audience
6. **Follow up** once after 5-7 days if no response

Add every podcast contact to Twenty CRM with category \`podcast\`.

### 1.4 Network Growth (Referral Partners)

Every industry has key players who are natural referral sources — they serve the same customer but in a different capacity. These are NOT competitors; they are complementary service providers.

**The rule: NO offers. Build genuine relationships. Get coffee. Become friends.**

Create \`research/industry-referral-map.md\` to map out the referral ecosystem:

\`\`\`
## Industry Referral Map

### Our Business: {business description}
### Our Customer: {ICP summary}

### Key Referral Source Categories:
1. {Category A} — e.g., "General Contractors" (for a home services business)
   - Why: They encounter our ideal customer during {situation}
   - Volume potential: high/medium/low
2. {Category B} — e.g., "Real Estate Agents"
   - Why: They refer clients who need {our service} during {situation}
   - Volume potential: high/medium/low
3. {Category C} — e.g., "Insurance Adjusters"
   - Why: ...
   - Volume potential: ...
\`\`\`

Create \`network-growth/overview.md\` with a master table:

| Contact | Company | Category | Location | Status | Last Contact |
|---------|---------|----------|----------|--------|-------------|
| {name} | {company} | General Contractor | {city} | researching | — |
| ... | ... | ... | ... | ... | ... |

#### How to identify local referral partners
- Use the industry referral map to know what categories to search for
- **Search Google Maps** for each referral category in the business's service area
- Search LinkedIn for local professionals in each category
- Check local business directories, Chamber of Commerce listings
- Ask the business owner: "Who sends you the most business right now?"
- Aim for 10-25 contacts per referral category

#### For each network contact, create a dedicated file (e.g., \`network-growth/{contact-slug}.md\`) containing:

- **Name and company**
- **Category** from the referral map
- **Location / service area**
- **What they do** — their business, their clients
- **Overlap** — why their clients would also need our services
- **Online presence** — website, social profiles, Google reviews
- **Recent activity** — new projects, awards, community involvement
- **Common ground** — mutual connections, shared community, same networking events
- **Relationship angle** — NOT a pitch. "I'd love to grab coffee and learn more about your business. I think we serve a lot of the same clients."
- **Contact info** — email, phone, LinkedIn

#### Network Growth Outreach Strategy
1. **Research** their business and find genuine common ground
2. **First touch** — short, friendly email: introduce yourself, mention the overlap, suggest coffee/meeting
3. **No offers** — you are building a friendship, not making a sale
4. **Provide value first** — send them a referral, share useful info, connect them with someone helpful
5. **Stay in touch** — monthly check-in, share relevant articles, invite to events
6. **Long game** — referral relationships take 3-6 months to develop, but compound over years

Add every network contact to Twenty CRM with category \`network-referral\`.

### Phase 1 Deliverables
- [ ] Sales outreach project created with full directory structure
- [ ] Twenty CRM installed and configured with custom categories
- [ ] ICP research completed (or imported from marketing project)
- [ ] Industry referral map created
- [ ] Dream 100 list built (25-100 targets) and added to CRM
- [ ] Influencer list built (20-50 targets) and added to CRM
- [ ] Podcast list built (25-50 targets) and added to CRM
- [ ] Network growth contacts identified (10-25 per category) and added to CRM
- [ ] Individual profile files created for each target across all categories
- [ ] Email templates drafted for each outreach category
- [ ] Outreach sequences started for Dream 100 and Network Growth (warm-up phase)

---

## Phase 2: Mass Outreach Campaigns

Mass outreach is volume-based and runs in parallel with the targeted outreach from Phase 1. Start with the **lowest risk channels first** and scale up.

### Risk Ordering (Start Here, Work Down)

| Channel | Risk Level | What You Risk | Scale Potential |
|---------|-----------|---------------|----------------|
| Cold Email | Low | Burner email accounts only | Very high |
| Social DM (LinkedIn, Twitter) | Medium | Account restrictions | Medium |
| SMS / Text | High | Phone numbers, compliance fines | High |

### 2.1 Cold Email Campaigns (Start Here — Lowest Risk)

Cold email is the safest mass outreach channel because you use dedicated sending accounts that are separate from your main business email. If accounts get flagged, you swap them out.

Create \`mass-outreach/cold-email/setup.md\` containing:

#### Infrastructure Setup
- **Sending platform** — Instantly, SmartLead, or similar cold email platform
  - Check Extensions marketplace for available options
  - If not available as an extension, guide the human to set up externally
- **Email accounts** — buy or create 5-10 dedicated sending accounts (separate domains, not the main business domain)
  - Use secondary domains (e.g., if business is acme.com, use acme-team.com, getacme.com)
  - Warm up accounts for 2-3 weeks before sending campaigns
- **Domain setup** — SPF, DKIM, DMARC configured for each sending domain
- **Daily sending limits** — 30-50 emails per account per day to start

#### List Building
Create \`mass-outreach/cold-email/lists/\` with targeted lead lists:
- Use web search, LinkedIn, and industry directories to build lists
- Each list file contains: name, email, company, title, industry, source
- Segment lists by: industry, company size, job title, location
- Verify emails before importing (use email verification services)
- Aim for 500-2000 verified contacts per campaign

#### Email Sequences
Create sequences in \`mass-outreach/cold-email/sequences/\`:
- **Sequence 1: Cold introduction** (3-5 emails over 14 days)
  - Email 1: Short, personalized intro — who you are, why you're reaching out, one clear value prop
  - Email 2 (Day 3): Follow-up with a case study or social proof
  - Email 3 (Day 7): Different angle — share a relevant insight or resource
  - Email 4 (Day 10): Break-up email — "Seems like timing isn't right, no worries"
  - Email 5 (Day 14): Final soft touch — "Just circling back one last time"
- **Key principles**:
  - Keep emails under 100 words
  - One CTA per email (reply, book a call, etc.)
  - Personalize at least the first line (reference their company, recent news, etc.)
  - No attachments, minimal links in first emails
  - A/B test subject lines and opening lines

#### Campaign Management
- Import lists into the cold email platform
- Load email sequences
- Set sending schedules (weekdays, business hours in recipient's timezone)
- Monitor: open rates (>50%), reply rates (>5%), bounce rates (<3%)
- Swap out underperforming email accounts
- Move positive replies to Twenty CRM for manual follow-up

### 2.2 Social DM Outreach (Medium Risk)

Direct messaging on LinkedIn, Twitter/X, Instagram, and Facebook. Higher risk because your main business profiles could get restricted.

Create \`mass-outreach/social-dm/setup.md\` containing:

#### Platform Prioritization
- **LinkedIn** — best for B2B, professional outreach. Use connection requests + messages.
- **Twitter/X** — good for engaging publicly first, then DM. Lower restriction risk.
- **Instagram** — good for B2C and creative industries. DMs get filtered for non-followers.
- **Facebook** — limited DM reach for non-friends, but good for Messenger with page.

#### Strategy
- **Warm up** before DM — engage with the person's content (like, comment, retweet) for a few days
- **Personalize** every message — reference their content, their business, something specific
- **Keep it short** — 2-3 sentences max for first message
- **No pitch in first message** — ask a question, give a compliment, start a conversation
- **Daily limits** — stay under platform thresholds (LinkedIn: 20-30 connections/day, Twitter: 20-30 DMs/day)
- **Use automation carefully** — tools that automate DMs can get accounts banned

#### Templates
Create templates in \`mass-outreach/social-dm/sequences/\` for each platform — but always personalize before sending.

### 2.3 SMS / Text Campaigns (Higher Risk)

Text messaging has the highest response rates but also the highest risk (compliance, cost, phone numbers).

Create \`mass-outreach/sms/setup.md\` containing:

#### Compliance First
- **TCPA (US)** — must have prior express written consent for marketing texts
- **GDPR (EU)** — explicit opt-in required
- **10DLC registration** — required for US A2P (application-to-person) messaging
- **Opt-out** — every message must include opt-out instructions
- Document compliance requirements in setup.md before any campaigns launch

#### Infrastructure
- SMS platform (Twilio, OpenPhone, or similar)
- Dedicated phone numbers (not your personal number)
- 10DLC campaign registration if sending in the US

#### Use Cases
- **Warm outreach** — follow up with people who've already engaged (replied to email, connected on LinkedIn)
- **Event invitations** — local networking events, webinars
- **Appointment reminders** — after meetings are booked
- **NOT recommended for** — cold outreach to people with no prior contact (high complaint risk)

### 2.4 Automation Workflows

Use n8n to connect the outreach systems. Load the \`n8n-workflow-automations\` skill for building:

- **CRM → Email sequence** — when a new contact is added to Twenty CRM with a specific tag, trigger the appropriate email sequence
- **Reply detection** — when a positive reply comes in, update CRM status and notify the human
- **Follow-up reminders** — scheduled reminders to follow up with Dream 100 and Network Growth contacts
- **Lead scoring** — track engagement (opens, clicks, replies) and surface the hottest leads
- **Cross-channel coordination** — if someone doesn't reply to email after sequence, queue them for social DM outreach

### Phase 2 Deliverables
- [ ] Cold email platform selected and configured
- [ ] Sending email accounts purchased, set up, and warming up
- [ ] Lead lists built and verified (500-2000 contacts per campaign)
- [ ] Cold email sequences written and loaded (3-5 emails per sequence)
- [ ] First cold email campaign launched
- [ ] Social DM outreach strategy documented per platform
- [ ] Social DM templates created
- [ ] SMS compliance requirements documented
- [ ] SMS infrastructure set up (if applicable)
- [ ] n8n automation workflows built for CRM integration and follow-up reminders
- [ ] Campaign monitoring dashboards or reports set up

---

## Available Extensions for Sales Outreach

| Extension | Purpose | Category |
|-----------|---------|----------|
| **Twenty CRM** | Contact management, deal tracking, outreach logging | CRM |
| **n8n** | Automation workflows connecting CRM, email, notifications | Automation |
| **Chatwoot** | Manage inbound replies across channels | Communication |
| **Mautic** | Email marketing automation for larger nurture campaigns | Email |
| **Postiz** | Social media management for warm-up engagement | Social |

---

## Execution Order

1. **Set up Twenty CRM first** — everything routes through the CRM
2. **Dream 100 and Network Growth start immediately** — these are relationship plays that take months
3. **Influencer and Podcast research runs in parallel** — build lists while warming up relationships
4. **Cold email launches after 2-3 weeks** — accounts need warm-up time
5. **Social DM starts after cold email is running** — layer channels progressively
6. **SMS only after compliance is confirmed** — do not skip compliance setup
7. **Review and iterate weekly** — check CRM pipeline, reply rates, and adjust

## Email Template Guidelines

All outreach emails follow these principles:
- **Short** — under 100 words for cold, under 200 for warm
- **Personalized** — reference something specific about the recipient
- **Value-first** — lead with what you can offer or share, not what you want
- **One CTA** — exactly one clear next step
- **No attachments** in first touch
- **Professional but human** — conversational tone, not corporate speak

Create templates in \`email-templates/\` for each category and a follow-up sequence in \`email-templates/follow-up-sequences/\`.

## Integration Tools

\`\`\`
integration_is_enabled({ integration_slug: "<slug>" })
integration_get_credentials({ integration_slug: "<slug>", include_secrets: true })
\`\`\`

## Project Management

This is a **Large** project. Use the Full PRD template (Tier 3) from the project-management skill. Keep PROJECT.md updated as phases are completed. Add to ACTIVE_PROJECTS.md.

If the marketing-plan project already exists, link to it and import the ICP research rather than duplicating it.
`;

export const salesDevelopmentOutreachSkill: NativeSkillDefinition = {
  name: 'sales-development-outreach',
  description: 'Sales development outreach plan — Dream 100, influencer marketing, podcast guesting, network growth, cold email, mass outreach campaigns, and CRM setup with Twenty.',
  tags: ['sales', 'outreach', 'dream-100', 'influencer', 'podcast', 'cold-email', 'sms', 'crm', 'twenty', 'networking', 'lead-generation', 'pipeline'],
  version: '1.0',
  async func() {
    return SKILL_DOC;
  },
};
