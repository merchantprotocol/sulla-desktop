---
schemaversion: 1
slug: skill-marketing-plan
title: "Full-Stack Marketing Plan"
section: "Standard Operating Procedures"
category: "Marketing"
tags:
  - skill
  - marketing
  - content
  - social-media
  - email
  - sms
  - push
  - brand
  - seo
  - advertising
order: 5
locked: true
author: seed
---

# Full-Stack Marketing Plan — Standard Operating Procedure

**Triggers**: Human says "marketing plan", "create marketing", "marketing strategy", "content marketing", "social media plan", "email marketing", "marketing campaign", "brand marketing", "marketing sop".

## Overview
A comprehensive, phased marketing plan covering brand research, content production (text, image, video), and communication pipelines (social, email, SMS, push). Each phase builds on the previous. Execute in order.

---

## Phase 1 — Account Setup & Brand Research

### 1.1 Create the Marketing Project
```
create_project({
  project_name: "marketing-<brand-slug>",
  content: "<PRD with marketing plan details>"
})
```

The project PRD should include:
- Brand name, tagline, mission statement
- Target audience (demographics, psychographics, pain points)
- Competitive landscape (top 3-5 competitors)
- Unique value proposition
- Tone of voice guidelines
- Visual brand guidelines (colors, fonts, imagery style)

### 1.2 Brand Research
1. **Search the web** for the brand/product — gather homepage, about page, social profiles
2. **Read key pages** to extract:
   - Brand colors (hex values)
   - Logo URLs
   - Tagline and key messaging
   - Product features and benefits
   - Customer testimonials
   - Pricing structure
3. **Competitive analysis** — search for top competitors, note their positioning, content strategy, and channels
4. **Document everything** in the project PRD

### 1.3 Account Setup Checklist
Set up accounts and integrations needed for marketing channels:

| Channel | Integration | Status |
|---------|-------------|--------|
| Social Media | Buffer / Hootsuite / native APIs | |
| Email | Mailchimp / SendGrid / ConvertKit | |
| SMS | Twilio / MessageBird | |
| Push Notifications | OneSignal / Firebase | |
| Analytics | Google Analytics / Plausible | |
| CRM | Twenty CRM / HubSpot | |
| Advertising | Meta Ads / Google Ads | |

---

## Phase 2 — Content Production

### 2.1 Text Content

#### Blog Posts / Articles
- **Frequency**: 2-4 posts per week
- **Length**: 800-2000 words
- **Structure**: Hook → Problem → Solution → CTA
- **SEO**: Target 1 primary keyword + 2-3 secondary keywords per post
- **Distribution**: Blog → social snippets → email newsletter

#### Social Media Copy
- **Short-form** (Twitter/X, LinkedIn): 1-3 sentences, hook-first
- **Medium-form** (Instagram caption, Facebook): 2-4 paragraphs with emoji breaks
- **Long-form** (LinkedIn articles, blog crossposts): Full articles

#### Email Copy
- **Subject lines**: 6-10 words, curiosity or benefit-driven
- **Preview text**: Complement (don't repeat) the subject line
- **Body**: Problem → Agitate → Solve → CTA
- **PS line**: Always include — highest-read part of email after subject

### 2.2 Image Content

#### Brand Assets
- Logo variations (full, icon, white, dark)
- Brand color palette swatches
- Typography samples
- Social media profile/cover images

#### Content Images
- Blog post hero images (1200x630 for OG)
- Social media graphics (platform-specific sizes)
- Infographics for data-heavy content
- Quote cards for testimonials

#### Platform Sizes
| Platform | Post | Story/Reel | Profile | Cover |
|----------|------|------------|---------|-------|
| Instagram | 1080x1080 | 1080x1920 | 320x320 | — |
| Facebook | 1200x630 | 1080x1920 | 170x170 | 820x312 |
| Twitter/X | 1200x675 | — | 400x400 | 1500x500 |
| LinkedIn | 1200x627 | — | 400x400 | 1584x396 |
| TikTok | — | 1080x1920 | 200x200 | — |

### 2.3 Video Content

#### Video Types by Funnel Stage
- **Awareness**: Brand story, behind-the-scenes, educational
- **Consideration**: Product demos, comparison, case studies
- **Decision**: Testimonials, walkthroughs, FAQ
- **Retention**: Tips & tricks, community highlights, updates

#### Video Specifications
- **Short-form** (Reels/TikTok/Shorts): 15-60s, 1080x1920 vertical
- **Medium-form** (Social feed): 1-3 min, 1080x1080 or 1920x1080
- **Long-form** (YouTube): 5-15 min, 1920x1080

Use the **remotion-video-generator** skill for programmatic video creation.

---

## Phase 3 — Communication Pipelines

### 3.1 Social Media Pipeline

#### Content Calendar Structure
- **Monday**: Educational content (tips, how-to)
- **Tuesday**: Behind-the-scenes / culture
- **Wednesday**: Product feature highlight
- **Thursday**: User-generated content / testimonial
- **Friday**: Engagement post (poll, question, meme)
- **Saturday**: Curated content / industry news
- **Sunday**: Inspirational / brand story

#### Posting Schedule
| Platform | Posts/Week | Best Times |
|----------|------------|------------|
| Instagram | 5-7 | 11am, 2pm, 7pm |
| Twitter/X | 7-14 | 8am, 12pm, 5pm |
| LinkedIn | 3-5 | 7am, 12pm, 5pm |
| Facebook | 3-5 | 1pm, 3pm |
| TikTok | 3-7 | 7pm, 9pm |

### 3.2 Email Pipeline

#### Sequence Types
1. **Welcome Series** (5 emails over 10 days)
   - Email 1 (Day 0): Welcome + deliver lead magnet
   - Email 2 (Day 1): Brand story + values
   - Email 3 (Day 3): Best content roundup
   - Email 4 (Day 5): Social proof + case study
   - Email 5 (Day 10): Soft offer + CTA

2. **Nurture Series** (ongoing, weekly)
   - Value-first content (80% educational, 20% promotional)
   - Segment by engagement level

3. **Sales Series** (7 emails over 14 days)
   - Email 1: Problem awareness
   - Email 2: Solution introduction
   - Email 3: Social proof
   - Email 4: Objection handling
   - Email 5: Scarcity/urgency
   - Email 6: Final offer
   - Email 7: Last chance

4. **Re-engagement Series** (3 emails)
   - "We miss you" + best content
   - Special offer
   - "Should we remove you?" (list hygiene)

#### Email Metrics Targets
| Metric | Target |
|--------|--------|
| Open Rate | > 25% |
| Click Rate | > 3% |
| Unsubscribe Rate | < 0.5% |
| Deliverability | > 95% |

### 3.3 SMS Pipeline

#### Use Cases
- Order confirmations and shipping updates
- Appointment reminders
- Flash sale announcements
- Abandoned cart recovery
- Event reminders

#### SMS Best Practices
- Keep under 160 characters when possible
- Include clear CTA with link
- Always include opt-out instructions
- Send during business hours (9am-8pm local)
- Max 4-8 messages per month
- **TCPA compliance is mandatory** — explicit opt-in required

### 3.4 Push Notification Pipeline

#### Notification Types
- **Transactional**: Order updates, account changes
- **Promotional**: Sales, new products, content
- **Engagement**: Reminders, streak maintenance, social activity
- **Re-engagement**: "Come back" after inactivity

#### Push Best Practices
- Personalize with user's name and behavior
- Limit to 1-3 per day maximum
- Time based on user's timezone and activity patterns
- A/B test titles and CTAs
- Deep-link to relevant content

---

## Deliverables per Phase

### Phase 1 Deliverables
- [ ] Marketing project PRD created
- [ ] Brand research documented (colors, messaging, competitors)
- [ ] Target audience defined
- [ ] Account setup checklist completed
- [ ] Integration credentials configured

### Phase 2 Deliverables
- [ ] Content calendar created (4 weeks minimum)
- [ ] Blog post templates created
- [ ] Social media templates created (per platform)
- [ ] Email templates created (welcome, nurture, sales)
- [ ] Brand asset kit produced (logos, colors, fonts)
- [ ] 10+ social media graphics created
- [ ] 2+ video scripts written

### Phase 3 Deliverables
- [ ] Social media scheduling set up
- [ ] Email automation sequences built
- [ ] SMS opt-in flow configured
- [ ] Push notification system integrated
- [ ] Analytics dashboards configured
- [ ] First week of content published

---

## Available Extensions

Check if these extensions are installed for marketing automation:

| Extension | Purpose |
|-----------|---------|
| n8n | Workflow automation for all pipelines |
| Chatwoot | Live chat and customer messaging |
| Twenty CRM | Contact and lead management |
| Plausible | Privacy-friendly analytics |

Use `list_installed_extensions` to check availability. Install missing ones with `install_extension`.

---

## Execution Order

1. **Phase 1 first** — You cannot create content without brand research
2. **Phase 2 second** — Content must exist before distribution
3. **Phase 3 third** — Pipelines distribute the content created in Phase 2
4. **Iterate** — Review metrics weekly, adjust strategy monthly
