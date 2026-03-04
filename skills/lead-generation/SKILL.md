---
schemaversion: 1
slug: skill-lead-generation
title: "Lead Generation & Appointment Booking"
section: "Standard Operating Procedures"
category: "Sales"
tags:
  - skill
  - leads
  - lead-generation
  - funnel
  - appointment
  - booking
  - crm
  - follow-up
  - organic
  - content
order: 5
locked: true
author: seed
---

# Lead Generation & Appointment Booking — Standard Operating Procedure

**Triggers**: Human says "lead generation", "generate leads", "lead gen", "appointment booking", "book appointments", "sales funnel", "lead funnel", "capture leads", "lead magnet", "landing page funnel".

## Overview
A systematic approach to generating leads and converting them into booked appointments. Covers the full funnel: attract → capture → qualify → convert → follow up.

### Core Loop
```
Traffic → Landing Page → Lead Capture → Qualification → Nurture → Appointment → Sale
```

---

## Phase 1 — Funnel & System Setup

### 1.1 Create the Lead Gen Project
```
create_project({
  project_name: "leadgen-<campaign-slug>",
  content: "<PRD with campaign details>"
})
```

The PRD should include:
- Campaign objective (leads, appointments, sales)
- Target audience / ICP
- Offer and lead magnet description
- Budget and timeline
- Funnel type (see below)
- Success metrics (CPL, conversion rate, appointments/week)

### 1.2 Funnel Types

Choose the right funnel for your goal:

#### Lead Magnet Funnel
**Best for**: Building email list, low-commitment first touch
```
Ad/Content → Landing Page → Email Opt-in → Thank You Page → Email Nurture → Appointment CTA
```
Lead magnets: ebooks, checklists, templates, free tools, mini-courses, reports

#### Webinar Funnel
**Best for**: High-ticket services, education-based selling
```
Ad/Content → Registration Page → Confirmation Page → Reminder Emails → Live/Recorded Webinar → Offer Page → Application/Booking
```

#### Direct Booking Funnel
**Best for**: Service businesses, consultants, agencies
```
Ad/Content → Landing Page → Calendar Booking → Confirmation → Reminder Sequence
```

#### Quiz/Survey Funnel
**Best for**: Personalized recommendations, segmentation
```
Ad/Content → Quiz Landing Page → Quiz Questions → Results + Offer → Email Capture → Segmented Follow-up
```

#### Free Trial Funnel
**Best for**: SaaS, software products
```
Ad/Content → Landing Page → Sign Up → Onboarding Sequence → Trial-to-Paid Conversion Emails
```

### 1.3 Landing Page Requirements

Every landing page must have:
- **Above the fold**: Headline, sub-headline, hero image/video, CTA button
- **Social proof**: Testimonials, logos, case studies, numbers
- **Benefits**: 3-5 key benefits (not features)
- **Objection handling**: FAQ section
- **CTA**: Repeated 3+ times throughout the page
- **Exit intent**: Popup with secondary offer

#### Landing Page Metrics Targets
| Metric | Target |
|--------|--------|
| Page load time | < 3 seconds |
| Conversion rate (opt-in) | > 20% |
| Conversion rate (booking) | > 10% |
| Bounce rate | < 60% |

### 1.4 TCPA Compliance (Critical)

**All lead capture must be TCPA compliant:**
- Explicit opt-in checkbox (not pre-checked) for SMS
- Clear disclosure of what they're opting into
- Link to privacy policy and terms
- Record of consent (timestamp, IP, form content)
- Honor opt-outs within 10 business days (immediately preferred)
- Include opt-out instructions in every message

### 1.5 CRM Integration

Set up Twenty CRM (or your chosen CRM) with:
- **Lead stages**: New → Contacted → Qualified → Appointment Set → Showed → No-Show → Closed
- **Lead source tracking**: Which funnel/channel generated the lead
- **Automation triggers**: Stage changes trigger follow-up sequences
- **Lead scoring**: Based on engagement, demographics, behavior

---

## Phase 2 — Follow-Up Systems

### 2.1 Speed-to-Lead

**The #1 factor in lead conversion is response time.**

| Response Time | Conversion Rate Impact |
|--------------|----------------------|
| < 1 minute | 391% higher |
| < 5 minutes | 100x more likely to connect |
| > 30 minutes | Dramatically lower |
| > 24 hours | Essentially dead |

#### Automated Speed-to-Lead Sequence
1. **Instant** (0 min): Automated email confirmation + SMS welcome
2. **2 minutes**: AI-triggered call or personalized SMS
3. **30 minutes**: Follow-up email with additional value
4. **2 hours**: SMS check-in if no response
5. **24 hours**: Second email with different angle
6. **48 hours**: Final SMS with urgency element

### 2.2 Email Follow-Up Sequences

#### New Lead Nurture (10 emails over 30 days)
| Email | Day | Subject Pattern | Content |
|-------|-----|----------------|---------|
| 1 | 0 | Deliver the promise | Lead magnet delivery + welcome |
| 2 | 1 | Quick win | Actionable tip they can use today |
| 3 | 3 | Story | Your/client origin story + lesson |
| 4 | 5 | Social proof | Case study with specific results |
| 5 | 7 | Education | Deep-dive on their #1 pain point |
| 6 | 10 | Objection | Address top objection with proof |
| 7 | 14 | Comparison | Why your approach vs alternatives |
| 8 | 18 | Urgency | Limited spots/time-based offer |
| 9 | 23 | Last chance | Final offer before sequence ends |
| 10 | 30 | Segmentation | "What are you most interested in?" |

### 2.3 SMS Follow-Up

#### Post-Opt-In SMS Sequence
```
Day 0 (immediate):
"Hi {first_name}! Thanks for requesting {lead_magnet}. Check your email for the download link. Questions? Reply here! - {brand}"

Day 1:
"{first_name}, did you get a chance to check out {lead_magnet}? Most people love the section on {key_topic}. Let me know if you have questions!"

Day 3:
"Quick question {first_name} - are you currently dealing with {pain_point}? We helped {client} achieve {result} in {timeframe}. Worth a quick chat?"

Day 7:
"{first_name}, I have a few spots open this week for a free {consultation_type}. Want me to save one for you? Reply YES and I'll send a calendar link."
```

### 2.4 Remarketing

Set up remarketing audiences:
- **Website visitors** (didn't convert): 7, 30, 90 day windows
- **Landing page visitors** (didn't opt in): Show social proof ads
- **Leads** (didn't book): Show testimonial + booking CTA
- **No-shows**: Re-engagement sequence

### 2.5 Lead Scoring

Score leads based on:

| Factor | Points |
|--------|--------|
| Opened email | +1 |
| Clicked email link | +3 |
| Visited pricing page | +5 |
| Downloaded resource | +5 |
| Replied to email/SMS | +10 |
| Booked appointment | +20 |
| Attended webinar | +15 |
| Requested demo | +25 |
| Negative: Unsubscribed | -50 |
| Negative: Marked spam | -100 |

**Thresholds**:
- 0-10: Cold lead → nurture sequence
- 11-30: Warm lead → accelerated follow-up
- 31-50: Hot lead → immediate personal outreach
- 51+: Sales-ready → direct to appointment booking

---

## Phase 3 — Organic Lead Generation

### 3.1 Content-Driven Leads

#### Content Types by Funnel Stage
| Stage | Content Type | CTA |
|-------|-------------|-----|
| Awareness | Blog posts, social media, videos, podcasts | Follow / Subscribe |
| Interest | Lead magnets, webinars, email courses | Opt-in |
| Consideration | Case studies, comparisons, demos | Book call |
| Decision | Testimonials, guarantees, pricing | Buy / Sign up |

#### SEO-Driven Lead Generation
1. **Keyword research**: Find high-intent keywords (e.g., "best {solution} for {audience}")
2. **Content creation**: 1500-3000 word articles targeting each keyword
3. **On-page optimization**: Title tags, meta descriptions, internal links, schema markup
4. **Content upgrades**: Relevant lead magnet embedded in each article
5. **Track**: organic traffic → opt-in rate → appointment rate per article

#### Social Media Lead Generation
- **LinkedIn**: Share expertise daily, comment on prospects' posts, use LinkedIn Lead Gen forms
- **Twitter/X**: Thread-based education, DM engagement, Twitter ads
- **Instagram**: Story polls/quizzes, link-in-bio to funnel, Reels for reach
- **YouTube**: Educational content with end-screen CTA to funnel
- **TikTok**: Short-form educational content, profile link to funnel

### 3.2 Referral System

Set up a structured referral program:
1. **Ask timing**: After positive outcome or testimonial
2. **Ask method**: Email + SMS combination
3. **Incentive**: Discount, credit, gift card, or mutual benefit
4. **Make it easy**: Pre-written referral message they can forward
5. **Track**: referral source, conversion rate, lifetime value of referred leads

### 3.3 Partnership Lead Generation

- **Joint webinars**: Co-host with complementary businesses
- **Content swaps**: Guest posts on each other's blogs
- **Bundle offers**: Package your service with a partner's
- **Referral agreements**: Formal commission structure for referrals
- **Co-marketing campaigns**: Shared email blasts to combined audiences

---

## Key Performance Indicators

### Funnel Metrics
| Metric | Formula | Target |
|--------|---------|--------|
| Cost per Lead (CPL) | Ad spend / Leads | Industry dependent |
| Opt-in Rate | Opt-ins / Landing page visitors | > 20% |
| Lead-to-Appointment Rate | Appointments / Leads | > 10% |
| Show Rate | Showed / Booked | > 70% |
| Close Rate | Sales / Appointments | > 20% |
| Cost per Appointment | Ad spend / Appointments | Industry dependent |
| Customer Acquisition Cost | Total spend / Customers | < LTV/3 |

### Activity Metrics (Weekly)
| Metric | Target |
|--------|--------|
| New leads generated | 50-200 |
| Follow-up emails sent | All leads within sequence |
| Appointments booked | 10-30 |
| Appointments held | 7-21 |
| Content pieces published | 3-5 |

---

## Available Extensions

| Extension | Purpose |
|-----------|---------|
| Twenty CRM | Lead management and pipeline |
| n8n | Follow-up automation sequences |
| Chatwoot | Live chat lead capture |
| Plausible | Funnel analytics |

---

## Execution Order

1. **Phase 1** (Week 1): Project setup, funnel build, CRM configuration, TCPA compliance
2. **Phase 2** (Week 2): Follow-up sequences built and tested, remarketing configured
3. **Phase 3** (Week 3+): Organic content production begins, referral system launched
4. **Ongoing**: Monitor KPIs weekly, optimize funnel monthly, add new traffic sources quarterly
