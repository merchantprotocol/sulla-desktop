---
schemaversion: 1
slug: skill-sales-development-outreach
title: "Sales Development & Outreach"
section: "Standard Operating Procedures"
category: "Sales"
tags:
  - skill
  - sales
  - outreach
  - crm
  - email
  - sms
  - prospecting
  - cold-outreach
  - dream-100
  - influencer
  - podcast
order: 5
locked: true
author: seed
---

# Sales Development & Outreach — Standard Operating Procedure

**Triggers**: Human says "sales outreach", "sales development", "cold outreach", "prospecting", "dream 100", "outbound sales", "sales campaign", "cold email", "lead outreach", "sales sop".

## Overview
A structured playbook for sales development — from CRM setup through targeted outreach (Dream 100, influencers, podcasts) to mass outreach campaigns (cold email, social DM, SMS). Execute phases in order; each builds on the previous.

---

## Phase 1 — Project Setup

### 1.1 Create the Sales Project
```
create_project({
  project_name: "sales-outreach-<campaign-slug>",
  content: "<PRD with campaign details>"
})
```

The PRD should include:
- Campaign name and objective
- Target market / ICP (Ideal Customer Profile)
- Offer / value proposition
- Budget and timeline
- Success metrics (meetings booked, deals closed, revenue)

### 1.2 CRM Configuration

#### Twenty CRM Setup
Twenty CRM is our preferred CRM (installed as a Docker extension).

1. Check if Twenty CRM is installed:
   ```
   list_installed_extensions({})
   ```
   Look for `twenty` in the results.

2. If not installed:
   ```
   install_extension({ id: "twenty" })
   ```

3. Configure pipeline stages:
   - **Lead** → **Contacted** → **Qualified** → **Meeting Booked** → **Proposal Sent** → **Closed Won** / **Closed Lost**

4. Create custom fields:
   - Source (Dream 100, Cold Email, Social DM, Referral, Inbound)
   - ICP Score (1-10)
   - Last Contact Date
   - Next Action Date
   - Campaign Tag

---

## Phase 2 — Targeted Outreach (High-Touch)

### 2.1 Dream 100 Strategy

The Dream 100 is a curated list of your top 100 ideal prospects or partners. These get personalized, high-touch outreach.

#### Building the Dream 100 List
1. **Define criteria**: Revenue range, industry, company size, tech stack, geography
2. **Research sources**: LinkedIn, Crunchbase, industry reports, conference speaker lists
3. **Score each prospect**: ICP fit (1-10), accessibility (1-10), potential value (1-10)
4. **Prioritize**: Top 20 get daily attention, next 30 get weekly, remaining 50 get bi-weekly

#### Dream 100 Outreach Sequence
| Day | Channel | Action |
|-----|---------|--------|
| 1 | Research | Deep-dive on prospect (LinkedIn, website, recent news, content) |
| 3 | Social | Follow/connect on LinkedIn + Twitter, engage with their content |
| 5 | Social | Meaningful comment on their latest post |
| 8 | Email | Personalized intro email (reference their content/achievement) |
| 12 | Social | Share their content with thoughtful commentary |
| 15 | Email | Value-add follow-up (relevant resource, intro, insight) |
| 20 | Social | DM with specific, personalized message |
| 25 | Email | Soft ask for 15-min conversation |
| 30 | Phone/Video | Call or video message if other channels silent |

#### Dream 100 Email Template
```
Subject: {specific_reference_to_their_work}

Hi {first_name},

I saw your {recent_content/achievement/talk} about {topic} — {specific_observation_showing_you_actually_consumed_it}.

{1-2 sentences connecting their work to a relevant insight or resource you can share}

Would love to exchange ideas on {specific_topic}. Open to a quick 15-min chat this week?

{your_name}
```

### 2.2 Influencer Outreach

#### Identifying Relevant Influencers
1. Search social platforms for industry thought leaders
2. Check follower count, engagement rate, audience overlap
3. Review their content themes and partnership history
4. Score by: reach, relevance, engagement, accessibility

#### Influencer Outreach Sequence
| Day | Action |
|-----|--------|
| 1-7 | Engage with their content daily (likes, comments, shares) |
| 8 | Send DM introducing yourself and your brand |
| 10 | Follow up with specific collaboration idea |
| 14 | Email with formal partnership proposal |
| 21 | Follow up with case study or social proof |

#### Collaboration Types
- **Content co-creation**: Guest posts, joint videos, podcast appearances
- **Product reviews**: Send product for honest review
- **Affiliate partnerships**: Commission-based promotion
- **Event co-hosting**: Webinars, workshops, live sessions
- **Brand ambassadorship**: Ongoing relationship

### 2.3 Podcast Outreach

#### Finding Relevant Podcasts
1. Search Apple Podcasts, Spotify, Podchaser for industry keywords
2. Filter by: audience size, episode frequency, guest format, relevance
3. Check if they accept guest pitches (usually in show notes or website)

#### Podcast Pitch Template
```
Subject: Guest Pitch: {compelling_topic_headline}

Hi {host_name},

I'm a listener of {podcast_name} — loved your episode with {recent_guest} about {topic}.

I'm {your_name}, {your_role} at {company}. I'd love to share insights on:

📌 {Topic 1}: {one-line description}
📌 {Topic 2}: {one-line description}
📌 {Topic 3}: {one-line description}

Quick credentials:
- {achievement_1}
- {achievement_2}
- {achievement_3}

Happy to tailor the topic to what resonates most with your audience. Here's my {media_kit_link/linkedin}.

Best,
{your_name}
```

### 2.4 Network Growth

#### Strategic Networking Actions
- **LinkedIn**: Connect with 10-20 targeted people daily, personalize every request
- **Twitter/X**: Engage in 5+ industry conversations daily
- **Communities**: Join 3-5 relevant Slack/Discord communities, contribute weekly
- **Events**: Attend 1-2 virtual/in-person events monthly
- **Referrals**: Ask every happy customer for 2-3 introductions

---

## Phase 3 — Mass Outreach (Scale)

### 3.1 Cold Email Campaigns

#### Infrastructure Setup
1. **Domain warmup**: New sending domains need 2-4 weeks of warmup
2. **SPF/DKIM/DMARC**: Configure for every sending domain
3. **Sending limits**: Start at 20/day, ramp to 50-100/day per mailbox
4. **Multiple mailboxes**: Use 3-5 sending accounts to distribute volume

#### Cold Email Sequence
| Email | Day | Purpose | Template |
|-------|-----|---------|----------|
| 1 | 0 | Introduction | Problem → credibility → soft CTA |
| 2 | 3 | Value-add | Share relevant case study or resource |
| 3 | 7 | Social proof | Customer result or testimonial |
| 4 | 12 | Different angle | New hook, different pain point |
| 5 | 18 | Breakup | "Should I close your file?" |

#### Cold Email Best Practices
- **Subject lines**: 3-7 words, lowercase, personal feel
- **Opening line**: Personalized reference (not "I hope this finds you well")
- **Body**: Max 3-4 short sentences per email
- **CTA**: One clear, low-friction ask (e.g., "Open to a quick chat this week?")
- **Signature**: Simple — name, title, phone, one link
- **Timing**: Tuesday-Thursday, 8-10am or 4-6pm recipient's timezone
- **Never**: Attachments in first email, HTML-heavy formatting, multiple CTAs

#### Personalization Variables
- `{first_name}` — prospect's first name
- `{company}` — prospect's company
- `{industry}` — prospect's industry
- `{pain_point}` — specific challenge relevant to their role
- `{mutual_connection}` — shared connection or community
- `{recent_trigger}` — funding round, job change, company news
- `{case_study_company}` — similar company you've helped

### 3.2 Social DM Campaigns

#### LinkedIn DM Sequence
| Step | Day | Message |
|------|-----|---------|
| 1 | 0 | Connection request with personalized note (300 char max) |
| 2 | 2 | Thank for connecting + value-add (article, insight) |
| 3 | 5 | Reference their content + relate to your expertise |
| 4 | 9 | Direct but respectful ask for meeting |
| 5 | 14 | "No worries if not a fit" breakup message |

#### Twitter/X DM Approach
1. Engage with their tweets for 1-2 weeks first
2. DM only after establishing some recognition
3. Keep DMs under 280 characters
4. Lead with value, not asks

### 3.3 SMS Outreach

**CRITICAL: TCPA Compliance Required**
- Must have explicit written consent before sending
- Include opt-out instructions in every message
- Only send during 8am-9pm recipient's local time
- Maintain opt-out list and honor immediately

#### SMS Use Cases for Sales
- Meeting reminders (after booking)
- Quick follow-ups after calls
- Time-sensitive offers
- Event invitations

#### SMS Templates
```
Meeting Reminder:
Hi {first_name}, just confirming our call tomorrow at {time}. Looking forward to chatting about {topic}. Reply Y to confirm or let me know if we need to reschedule. - {your_name}

Post-Call Follow-Up:
{first_name} - great chatting today! Sending over the {resource} we discussed via email now. Let me know if any questions come up. - {your_name}
```

---

## Execution Order

1. **Phase 1 first** — CRM and project setup (Day 1-3)
2. **Phase 2 starts** — Dream 100 list building (Day 1-7), outreach begins (Day 8+)
3. **Phase 3 starts** — Cold email infrastructure (Day 1-14 warmup), campaigns launch (Day 15+)
4. **Ongoing** — All phases run simultaneously once launched

---

## Key Performance Indicators

### Activity Metrics
| Metric | Daily Target |
|--------|-------------|
| Cold emails sent | 50-100 |
| LinkedIn connections sent | 10-20 |
| Social engagements | 20+ |
| Dream 100 touches | 5-10 |

### Outcome Metrics
| Metric | Weekly Target |
|--------|--------------|
| Email reply rate | > 5% |
| Meeting booked rate | > 2% of outreach |
| Meetings held | 5-10 |
| Pipeline value added | Varies by deal size |

---

## Available Extensions

| Extension | Purpose |
|-----------|---------|
| Twenty CRM | Contact management and pipeline tracking |
| n8n | Automation for email sequences and follow-ups |
| Chatwoot | Inbound conversation management |

Use `list_installed_extensions` to check availability.

---

## Email Template Guidelines

### Structure
Every outreach email follows this structure:
1. **Hook** (first line): Personalized, relevant, shows you did research
2. **Bridge** (1-2 sentences): Connect their situation to your value
3. **CTA** (last line): Single, clear, low-friction ask

### What Makes Good Personalization
- Reference something **specific** and **recent** (last 30 days)
- Show you understand their **role** and **challenges**
- Connect to a **relevant result** you've achieved for someone similar

### What to Avoid
- Generic opening lines ("I hope this finds you well")
- Feature dumps (save for later conversations)
- Multiple asks in one email
- Desperation signals ("just following up", "circling back")
- Attachments in cold emails (triggers spam filters)
