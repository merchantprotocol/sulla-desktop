import type { NativeSkillDefinition } from './NativeSkillRegistry';

const SKILL_DOC = `---
schemaversion: 1
slug: lead-generation
title: "Lead Generation & Appointment Booking"
section: "Standard Operating Procedures"
category: "Marketing"
tags:
  - skill
  - lead-generation
  - funnels
  - landing-pages
  - lead-magnets
  - appointments
  - remarketing
  - organic
  - conversion
related:
  - project-management
  - marketing-plan
  - sales-development-outreach
  - facebook-ads
  - n8n-workflow-automations
  - new-software-development-project
order: 7
locked: true
author: seed
---

# Lead Generation & Appointment Booking — Standard Operating Procedure

**Triggers**: Human says "lead generation", "generate leads", "more appointments", "more quotes", "book more calls", "need more sales", "landing page", "lead magnet", "funnel", "convert prospects", "appointment booking", "get more clients", "inbound leads", "organic leads", "lead gen".

## Overview

This skill converts marketing awareness into actual business — leads, appointments, quotes, and sales conversations. Marketing gets your voice out there; lead generation captures the people who raise their hand and moves them toward a booked appointment or inbound call.

The core loop:
1. **Attract** — drive prospects to a funnel via organic content (videos, social posts, giveaways, lead magnets)
2. **Capture** — collect their information through a landing page, survey, or form
3. **Qualify** — determine if they are a good fit and ready to buy
4. **Convert** — book them into an appointment, phone call, or quote request
5. **Follow up** — remarketing, drip campaigns, reminders to ensure they show up

Paid ads amplify what works organically but are a **separate skill** on a per-platform basis. This skill focuses on building the systems and the organic pathways to generating leads and appointments.

---

## Project Setup

### Create the Lead Generation Project

\`\`\`
create_workspace("lead-gen-{business-slug}")
\`\`\`

Write a \`PROJECT.md\` using the Full PRD template from the project-management skill. Then create the following file structure:

\`\`\`
lead-gen-{business-slug}/
+-- PROJECT.md
+-- README.md
+-- research/
|   +-- ideal-customer-profile.md
|   +-- offer-mapping.md
|   +-- funnel-strategy.md
+-- funnels/
|   +-- overview.md
|   +-- {funnel-name}/
|       +-- funnel-spec.md
|       +-- landing-page.md
|       +-- thank-you-page.md
|       +-- lead-magnet.md
|       +-- form-fields.md
+-- lead-magnets/
|   +-- overview.md
|   +-- {magnet-name}.md
+-- follow-up/
|   +-- overview.md
|   +-- email-sequences/
|   |   +-- initial-welcome.md
|   |   +-- nurture-sequence.md
|   |   +-- no-show-recovery.md
|   +-- sms-sequences/
|   |   +-- appointment-confirmation.md
|   |   +-- reminder-sequence.md
|   +-- remarketing/
|       +-- strategy.md
+-- organic/
|   +-- overview.md
|   +-- video-content/
|   +-- social-lead-posts/
|   +-- giveaways/
+-- qualification/
|   +-- scoring-criteria.md
|   +-- disqualification-rules.md
+-- tracking/
    +-- kpis.md
    +-- conversion-rates.md
\`\`\`

---

## Phase 1: Funnel & System Setup

### 1.1 Offer Mapping

Before building any funnel, define what the business is offering at each stage. Create \`research/offer-mapping.md\`:

- **Core offer** — what the business ultimately sells (product, service, subscription)
- **Lead magnet offer** — the free thing that gets people into the funnel
- **Appointment type** — what the prospect is booking (discovery call, free consultation, quote, demo, audit)
- **Conversion goal** — the specific action that counts as a "lead" (phone call, form submission, appointment booked, quote requested)

| Funnel | Lead Magnet | Conversion Goal | Target ICP Segment |
|--------|-------------|-----------------|-------------------|
| Survey funnel | Free assessment | Appointment booked | Segment A |
| Giveaway funnel | Free guide/tool | Email captured + nurture | Segment B |
| Quote funnel | Instant estimate | Quote request submitted | Segment C |

### 1.2 Funnel Strategy

Create \`research/funnel-strategy.md\` to plan the funnels. Multiple funnels can exist to match different ICPs or offers.

Funnel types to consider:
- **Survey/Questionnaire funnel** — prospect answers qualifying questions, gets personalized result, books a call
- **Free giveaway funnel** — prospect downloads a resource (PDF, checklist, template, tool) in exchange for contact info
- **Webinar/Training funnel** — prospect registers for a free training, gets nurtured into a call
- **Quote/Estimate funnel** — prospect fills out project details, gets a ballpark quote, books a detailed consultation
- **VSL (Video Sales Letter) funnel** — prospect watches a video explaining the offer, then books
- **Challenge funnel** — prospect joins a free multi-day challenge, gets nurtured through the experience

For each funnel, document:
- Target ICP segment
- Traffic source (which organic content drives here)
- Lead magnet or offer
- Number of steps
- Qualifying questions (if applicable)
- Conversion goal (what counts as a lead)

### 1.3 Build Funnels

For each funnel, create a folder \`funnels/{funnel-name}/\` with:

#### Landing Page (\`landing-page.md\`)
- **Headline** — clear benefit statement addressing ICP's primary pain point
- **Subheadline** — what they get and why it matters
- **Hero section** — image/video + CTA above the fold
- **Social proof** — testimonials, logos, review count, case study snippets
- **Benefits list** — 3-5 bullet points of what they get
- **FAQ section** — overcome top 3-5 objections
- **CTA** — one clear action (submit form, book call, download, start quiz)
- **Mobile-optimized** — majority of traffic is mobile
- **Page speed** — fast loading, no unnecessary scripts

Build the landing page using available tools:
- If WordPress is installed, create pages there
- Otherwise, build as a static page in the workspace and deploy
- Load the \`new-software-development-project\` skill if a custom build is needed

#### Lead Magnet (\`lead-magnet.md\`)
- **What it is** — PDF guide, checklist, calculator, template, video training, free tool
- **Title** — benefit-driven, specific ("The 5-Step Checklist to {Desired Outcome}")
- **Content outline** — what the lead magnet covers
- **Delivery method** — email, instant download, redirect to resource page
- **Production plan** — who creates it, timeline, tools needed

#### Form Fields (\`form-fields.md\`)
- **Required fields** — minimum info needed (name, email, phone)
- **Qualifying fields** — questions that help score the lead (budget, timeline, company size, project type)
- **TCPA/consent** — checkbox for text message consent, privacy policy link
- **Progressive profiling** — if multi-step, which fields on which step

#### Thank You Page (\`thank-you-page.md\`)
- **Confirmation message** — what happens next, when to expect contact
- **Process explanation** — clear steps of what the prospect should do and expect
- **Calendar booking** — embed scheduling widget if the goal is an appointment
- **Upsell/next step** — optional secondary CTA (join community, follow social, watch video)

### 1.4 TCPA Consent & Compliance

Create compliance documentation within each funnel:
- **Opt-in language** — clear consent text for email, SMS, and phone
- **Privacy policy** — link to privacy policy on every form
- **Terms of service** — link where applicable
- **Unsubscribe mechanism** — every email and SMS must include opt-out
- **Data handling** — how lead data is stored and processed

### 1.5 CRM & Lead Routing

Ensure Twenty CRM is set up (from the sales-development-outreach skill, or set up fresh):

\`\`\`
integration_is_enabled({ integration_slug: "twenty" })
\`\`\`

Configure lead routing:
- **New lead tag** — auto-tag leads by funnel source
- **Lead status pipeline** — new > contacted > qualified > appointment-booked > showed-up > closed
- **Assignment rules** — who handles which leads (if multiple salespeople)
- **Speed-to-lead** — goal is to contact new leads within 5 minutes

### Phase 1 Deliverables
- [ ] Offer mapping completed
- [ ] Funnel strategy documented with funnel types identified
- [ ] At least one primary funnel built (landing page + lead magnet + form + thank you page)
- [ ] TCPA consent and compliance configured
- [ ] CRM configured with lead pipeline and routing
- [ ] Form submissions wired to CRM via n8n or direct integration

---

## Phase 2: Follow-Up Systems

The follow-up systems are what turn raw leads into qualified appointments that actually show up. Without follow-up, 80%+ of leads go cold.

### 2.1 Immediate Response (Speed to Lead)

When a new lead comes in, trigger **immediately** (within seconds):

1. **Confirmation email** — "Thanks for requesting your {lead magnet/quote/appointment}. Here is what happens next..."
2. **Confirmation text** (if TCPA consent given) — "Hi {name}, this is {business}. We received your request. {Next step instructions}."
3. **CRM notification** — alert the sales team that a new lead came in
4. **Auto-booking** — if using a scheduling tool, send calendar link immediately

Use n8n to build these automations. Load the \`n8n-workflow-automations\` skill:
- **Trigger**: form submission webhook or CRM new-contact event
- **Actions**: send email, send SMS, update CRM, notify team

### 2.2 Email Drip Sequences

Create sequences in \`follow-up/email-sequences/\`:

#### Initial Welcome Sequence (3-5 emails over 7 days)
- **Email 1 (immediate)**: Deliver the lead magnet + explain what happens next + set expectations
- **Email 2 (Day 1)**: Provide additional value related to their problem. Share a quick win or tip.
- **Email 3 (Day 3)**: Social proof — case study, testimonial, or before/after result
- **Email 4 (Day 5)**: Address the #1 objection. Why now? What happens if they don't act?
- **Email 5 (Day 7)**: Direct CTA — book the appointment, reply to this email, call this number

#### Nurture Sequence (for leads not yet ready)
- Weekly or biweekly emails with value-driven content
- Mix of educational content, case studies, tips, and soft CTAs
- Re-engage sequence if they go dark for 30+ days

#### No-Show Recovery Sequence
- **Text (5 min after missed appointment)**: "Hey {name}, I noticed we missed our call. No worries — here is a link to reschedule: {link}"
- **Email (1 hour after)**: Friendly reschedule email with calendar link
- **Text (next day)**: One more follow-up with a different time suggestion
- **Email (Day 3)**: "I want to make sure you still get {the thing they wanted}. Here are a few open times this week."

### 2.3 SMS/Text Sequences

Create sequences in \`follow-up/sms-sequences/\`:

#### Appointment Confirmation
- **Immediate**: "Your {appointment type} is confirmed for {date/time}. Reply YES to confirm."
- **24 hours before**: "Reminder: Your {appointment type} is tomorrow at {time}. Reply if you need to reschedule."
- **1 hour before**: "See you in 1 hour! Here is {any prep info, address, Zoom link}."

#### Process Explanation
- After form submission, send a text explaining:
  - What they signed up for
  - What the next step is
  - When and how they will be contacted
  - What to expect during the appointment

### 2.4 Remarketing Strategy

Create \`follow-up/remarketing/strategy.md\`:

- **Website retargeting pixels** — install Facebook Pixel, Google Ads tag, LinkedIn Insight tag on all funnel pages
- **Custom audiences** — build audiences from page visitors, form starters, form completers
- **Lookalike audiences** — create lookalikes from converted leads for future paid campaigns
- **Email list retargeting** — upload lead lists to ad platforms for retargeting
- **Content retargeting** — show relevant content to people who visited but didn't convert

Note: the actual paid remarketing campaigns are a separate skill. This step is about installing the tracking and building the audiences.

### 2.5 Qualification & Scoring

Create \`qualification/scoring-criteria.md\`:

| Factor | Weight | Scoring |
|--------|--------|---------|
| Budget range | High | Matches: +3, Low: +1, None: 0 |
| Timeline | High | Immediate: +3, 1-3 months: +2, Exploring: +1 |
| Decision maker | Medium | Yes: +2, No: +0 |
| Company size | Medium | Enterprise: +3, Mid: +2, Small: +1 |
| Engagement | Low | Opened 3+ emails: +1, Clicked: +2, Replied: +3 |

Create \`qualification/disqualification-rules.md\`:
- Lead is outside service area
- Budget is below minimum threshold
- Timeline is 6+ months out
- Not the decision maker and can't connect us to one
- Fake/spam submission (invalid email, nonsense answers)

Disqualified leads get tagged in CRM and moved to a long-term nurture sequence instead of active follow-up.

### Phase 2 Deliverables
- [ ] Immediate response automation built (email + SMS + CRM notification)
- [ ] Initial welcome email sequence written and loaded
- [ ] Nurture email sequence written
- [ ] No-show recovery sequence written
- [ ] SMS appointment confirmation sequence written
- [ ] Remarketing pixels installed on all funnel pages
- [ ] Custom audiences created on ad platforms
- [ ] Lead scoring criteria defined
- [ ] Disqualification rules documented
- [ ] All sequences connected via n8n automations

---

## Phase 3: Organic Lead Generation

Once the funnels and follow-up systems are in place, drive traffic organically. Start with the easiest and lowest-cost methods first.

### 3.1 Social Profile Lead Posts

Create lead-generating posts for the business's social profiles. These are different from regular brand content — they have a **specific CTA driving to a funnel**.

Store in \`organic/social-lead-posts/\`:

- **Problem-agitate-solve posts** — describe the ICP's pain, agitate it, then CTA to the funnel
- **Result/transformation posts** — show a before/after or case study, CTA to "get the same result"
- **Giveaway posts** — "Comment [KEYWORD] and I will send you {lead magnet}" — then DM the funnel link
- **Poll/question posts** — engage the audience, then follow up with the funnel in comments or DMs
- **Carousel/thread posts** — educational content that ends with a CTA to the funnel

Each post includes:
- Platform (Instagram, LinkedIn, Twitter, TikTok, Facebook)
- Post copy
- CTA and funnel link
- Hashtags
- Suggested publish time
- Associated funnel

### 3.2 Organic Video Content

Video is the highest-converting organic content. Create briefs in \`organic/video-content/\`:

#### Short-Form (Reels, TikTok, Shorts)
- **Hook** (first 1-3 seconds) — stop the scroll with a bold statement, question, or visual
- **Value** (15-45 seconds) — deliver a quick tip, insight, or transformation
- **CTA** (last 3-5 seconds) — "Link in bio", "Comment KEYWORD", "DM me for {lead magnet}"
- Keep under 60 seconds
- Film 5-10 at a time in batch sessions

#### Long-Form (YouTube, Facebook)
- **Educational/how-to videos** that address ICP pain points
- Include CTA to lead magnet or funnel in description and verbally in the video
- Optimize title, description, and tags for search (SEO from marketing plan)

#### Video-to-Lead Pipeline
1. Post organic video
2. Monitor engagement (views, comments, shares)
3. If a video performs well organically, it becomes a candidate for paid promotion (separate skill)
4. Respond to every comment — engage and direct to funnel when appropriate

### 3.3 Lead Magnet Distribution

Distribute lead magnets through organic channels:

- **Social posts** — regular posts offering the lead magnet with CTA
- **Bio links** — lead magnet link in all social profile bios
- **Community groups** — share the lead magnet in relevant groups (follow the group content rules from the marketing-plan skill — be helpful first, share resource naturally)
- **Email signature** — add lead magnet CTA to business email signatures
- **Blog posts** — embed lead magnet CTAs within blog content (content upgrades)
- **Podcast appearances** — mention lead magnet as the CTA when guesting on podcasts (from sales-development-outreach skill)
- **Partner cross-promotion** — share lead magnets with network growth contacts who can distribute to their audience

### 3.4 Giveaway Campaigns

Create giveaway specs in \`organic/giveaways/\`:

- **Prize** — something the ICP genuinely wants (free consultation, product sample, tool, resource bundle)
- **Entry mechanism** — comment keyword, fill out form, share post, tag friends
- **Duration** — typically 3-7 days
- **Rules** — clear terms, eligibility, winner selection
- **Follow-up** — all entrants go into the lead nurture pipeline, not just the winner
- **Winner announcement** — public announcement creates social proof and engagement

### 3.5 Conversion Optimization

After funnels are live and receiving traffic, continuously optimize:

- **A/B test landing pages** — headlines, CTAs, form length, page layout
- **Track funnel metrics** — page views, form starts, form completions, appointment bookings, show-up rates
- **Identify drop-off points** — where are people leaving? Fix those pages/steps
- **Test different lead magnets** — which offers generate the most qualified leads?
- **Test form length** — fewer fields = more leads, more fields = higher quality leads
- **Optimize for mobile** — test every funnel step on mobile devices

Document all tests and results in \`tracking/conversion-rates.md\`.

### Phase 3 Deliverables
- [ ] Social lead posts created for each platform (at least 2 weeks of posts)
- [ ] Organic video content briefs written (5-10 short-form, 2-3 long-form)
- [ ] Lead magnets distributed across all organic channels
- [ ] At least one giveaway campaign planned and ready to launch
- [ ] Bio links updated on all social profiles to point to primary funnel
- [ ] Blog content upgraded with lead magnet CTAs
- [ ] Funnel tracking set up (page views, conversions, show-up rates)
- [ ] First round of A/B tests planned

---

## KPIs & Tracking

Create \`tracking/kpis.md\` with the metrics that matter:

| Metric | Target | Frequency |
|--------|--------|-----------|
| Leads generated per week | {goal} | Weekly |
| Cost per lead (organic) | $0 (time only) | Weekly |
| Landing page conversion rate | 20-40% | Weekly |
| Lead-to-appointment rate | 30-50% | Weekly |
| Appointment show-up rate | 70-80% | Weekly |
| Speed to lead (first contact) | < 5 minutes | Per lead |
| Email open rate (sequences) | > 40% | Weekly |
| SMS response rate | > 20% | Weekly |
| Funnel drop-off rate per step | < 30% per step | Weekly |

---

## Available Extensions for Lead Generation

| Extension | Purpose | Category |
|-----------|---------|----------|
| **WordPress** | Landing pages, blog, lead capture forms | Funnels |
| **Twenty CRM** | Lead management, pipeline, follow-up tracking | CRM |
| **n8n** | Automation workflows for follow-up sequences | Automation |
| **Mautic** | Email marketing automation, drip campaigns | Email |
| **Chatwoot** | Live chat on landing pages, inbound lead capture | Communication |
| **Novu** | Multi-channel notification delivery (email, SMS, push) | Notifications |
| **Postiz** | Social media scheduling for lead posts | Social |
| **Remotion** | Programmatic video generation for ad content | Video |

---

## Execution Order

1. **Offer mapping and funnel strategy first** — know what you are offering before building anything
2. **Build one primary funnel** — landing page + lead magnet + form + thank you page
3. **Wire up follow-up systems immediately** — a funnel without follow-up wastes every lead
4. **Start organic distribution** — social posts, video content, giveaways
5. **Monitor and optimize** — track KPIs weekly, A/B test continuously
6. **Scale what works** — when an organic post or funnel converts well, it becomes a paid ad candidate (separate skill)
7. **Add more funnels** — create additional funnels for different ICP segments or offers

## Integration Tools

\`\`\`
integration_is_enabled({ integration_slug: "<slug>" })
integration_get_credentials({ integration_slug: "<slug>", include_secrets: true })
\`\`\`

## Project Management

This is a **Large** project. Use the Full PRD template (Tier 3) from the project-management skill. Keep PROJECT.md updated as phases are completed. Add to ACTIVE_PROJECTS.md.

If the marketing-plan or sales-development-outreach projects already exist, link to them and import relevant research rather than duplicating it.
`;

export const leadGenerationSkill: NativeSkillDefinition = {
  name: 'lead-generation',
  description: 'Lead generation and appointment booking — funnels, landing pages, lead magnets, follow-up sequences (email/SMS), remarketing, organic video and social lead posts, giveaways, and conversion optimization.',
  tags: ['lead-generation', 'funnels', 'landing-pages', 'lead-magnets', 'appointments', 'follow-up', 'remarketing', 'organic', 'conversion', 'email-sequences', 'sms', 'qualification', 'sales'],
  version: '1.0',
  async func() {
    return SKILL_DOC;
  },
};
