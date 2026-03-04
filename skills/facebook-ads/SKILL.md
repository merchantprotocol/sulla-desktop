---
schemaversion: 1
slug: facebook-ads
title: "Facebook Ads Management"
section: "Standard Operating Procedures"
category: "Paid Advertising"
tags:
  - skill
  - facebook-ads
  - meta-ads
  - paid-advertising
  - lead-generation
  - ad-management
  - competitive-analysis
related:
  - project-management
  - marketing-plan
  - lead-generation
  - sales-development-outreach
  - n8n-workflow-automations
order: 8
locked: true
author: seed
---

# Facebook Ads Management — Standard Operating Procedure

**Triggers**: Human says "facebook ads", "meta ads", "run facebook ads", "facebook ad campaign", "facebook lead ads", "FB ads", "paid facebook", "facebook advertising", "instagram ads via meta", "boost posts", "facebook ad management".

## Overview

This skill manages paid Facebook (Meta) advertising campaigns. It covers competitive ad research, offer positioning, creative development, campaign structure, and optimization. The goal is to generate qualified leads at a profitable cost.

**Key principles:**
- Facebook's algorithm handles targeting well — **the creative and the offer are what matter most**
- Start with native lead form campaigns to prove the ad works before sending traffic to landing pages
- Research competitors heavily — you are competing for the same eyeballs
- Find the middle ground on offers — not too scammy (free everything, garbage leads) and not too premium (high quality but no volume)

**See the Related Skills section below for how this skill connects to marketing-plan, lead-generation, sales-development-outreach, and project-management.**

---

## Project Setup

### Create the Facebook Ads Project

```
create_workspace("facebook-ads-{business-slug}")
```

Write a `PROJECT.md` using the Full PRD template from the project-management skill. Then create the following file structure:

```
facebook-ads-{business-slug}/
+-- PROJECT.md
+-- README.md
+-- research/
|   +-- competitive-ad-analysis.md
|   +-- ad-library-research.md
|   +-- offer-spectrum.md
|   +-- winning-patterns.md
+-- campaigns/
|   +-- overview.md
|   +-- {campaign-name}/
|       +-- campaign-spec.md
|       +-- ad-sets.md
|       +-- creatives/
|       |   +-- {ad-name}.md
|       +-- results.md
+-- creatives/
|   +-- copy-templates.md
|   +-- image-specs.md
|   +-- video-specs.md
|   +-- hooks.md
+-- offers/
|   +-- offer-strategy.md
|   +-- {offer-name}.md
+-- tracking/
    +-- kpis.md
    +-- weekly-reports/
    +-- optimization-log.md
```

### Facebook Ads MCP / API Connection

Check for available Facebook/Meta ads integration or MCP:

```
integration_is_enabled({ integration_slug: "facebook" })
integration_is_enabled({ integration_slug: "meta-ads" })
```

If an MCP server is available for Meta Ads API:
- Launch the MCP docker container
- Configure with the business's ad account credentials
- This enables programmatic campaign creation, management, and reporting

If no MCP is available:
- Document all campaign specs in the project files
- The human creates/manages campaigns manually in Meta Ads Manager
- Agent provides the strategy, copy, creative briefs, and optimization recommendations

---

## Phase 1: Competitive Ad Research

This is the most critical phase. Before spending any money, understand what you are competing against.

### 1.1 Facebook Ad Library Research

The Facebook Ad Library (https://www.facebook.com/ads/library/) is a public database of all active ads on Meta platforms. Use it extensively.

Create `research/ad-library-research.md` documenting:

#### Search Strategy
- Search for direct competitors by name
- Search for industry keywords (what the ICP would search for)
- Search for known brands in the niche
- Filter by country/region matching the business's target market
- Filter by active ads (longer-running ads = likely profitable)

#### For each competitor/advertiser found, document:
- **Advertiser name** and page URL
- **Number of active ads** — more active ads = bigger spender, take them seriously
- **How long ads have been running** — ads running 30+ days are likely profitable (they would not keep spending otherwise)
- **Ad formats used** — image, video, carousel, collection
- **Ad copy patterns** — headlines, body text, CTAs
- **Offers used** — what are they offering? Free quote? Discount? Free guide? Consultation?
- **Landing page** (if visible) — where does the ad send people?
- **Creative style** — professional photography, UGC (user-generated content), text overlays, before/after

#### Volume Research
Search broadly and document at least 20-50 competitor ads. The goal is to see the full competitive landscape.

### 1.2 Competitive Ad Analysis

Create `research/competitive-ad-analysis.md` with a structured analysis:

#### Ad Ranking (Most Competitive to Least)
As you scroll through ad results, the top ads get the most engagement/interaction. Document them in order:

| Rank | Advertiser | Ad Type | Offer | Running Since | Engagement Level | Notes |
|------|-----------|---------|-------|--------------|-----------------|-------|
| 1 | {name} | Video | Free estimate | 60+ days | Very high | Top competitor |
| 2 | {name} | Image | 20% off | 45+ days | High | Strong creative |
| 3 | {name} | Carousel | Free guide | 30+ days | Medium | Good copy |
| ... | ... | ... | ... | ... | ... | ... |

#### Pattern Analysis
After reviewing 20-50 ads, identify:
- **Most common offer type** — what offers appear most frequently?
- **Most common ad format** — video vs image vs carousel?
- **Most common hooks** — what opening lines/visuals grab attention?
- **Most common CTAs** — "Learn More", "Get Quote", "Sign Up", "Book Now"?
- **Tone and style** — professional, casual, urgent, educational?
- **What the top 3 ads have in common** — why are they winning?
- **Gaps and opportunities** — what is nobody saying? What angle is missing?

### 1.3 Offer Spectrum Analysis

Create `research/offer-spectrum.md` to position the business's offer correctly:

```
## The Offer Spectrum

LOW QUALITY <<<<<<<<<<<<<<<<<<>>>>>>>>>>>>>>>>>>>> HIGH QUALITY
(High volume, bad leads)                    (Low volume, great leads)

|---------|---------|---------|---------|---------|
Scam-y    Free     Mid-range  Premium   Ultra-
Free      + Value  Offer      Offer     Premium
Stuff     Offer

Examples:
- "Get this FREE" (tons of leads, nobody buys)
- "Free guide + consultation" (good volume, decent quality)
- "Free assessment/audit" (medium volume, good quality)
- "Request a custom quote" (lower volume, high quality)
- "Apply to work with us" (very low volume, highest quality)
```

#### Finding the Sweet Spot
Based on the competitive analysis:
- Where do most competitors sit on this spectrum?
- Where is there an opening?
- What offer balances volume AND quality for this business?
- What can we offer that feels more valuable than competitors but still generates volume?

Document the chosen offer position and rationale.

### 1.4 Winning Patterns

Create `research/winning-patterns.md` synthesizing everything:

- **Top 5 hooks** that work in this niche (first line of copy or first 3 seconds of video)
- **Top 3 offers** that balance volume and quality
- **Top 3 ad formats** for this niche
- **Top 3 creative styles** (UGC, professional, graphic, etc.)
- **Must-have elements** for ads in this niche
- **Things to avoid** — what the losing ads have in common

### Phase 1 Deliverables
- [ ] Facebook Ad Library researched (20-50 competitor ads documented)
- [ ] Competitive ad analysis completed with ranking
- [ ] Pattern analysis identifying what the top ads have in common
- [ ] Offer spectrum mapped and sweet spot identified
- [ ] Winning patterns document created
- [ ] Ad/API connection established (MCP or manual)

---

## Phase 2: Campaign Creation — Lead Form First

### 2.1 Campaign Strategy

Start with **native Facebook lead form campaigns** (not landing page traffic). Why:
1. Lead forms keep users on Facebook — lower friction, higher conversion rate
2. This proves the **ad creative and offer work** before adding landing page variables
3. Faster data collection to optimize
4. Once ads are proven, switch to sending traffic to landing pages (from the lead-generation skill)

Create `campaigns/overview.md` with the campaign plan:

| Campaign | Objective | Offer | Budget/Day | Status |
|----------|----------|-------|-----------|--------|
| Lead Gen Test 1 | Leads (native form) | {offer} | $20-50 | planned |
| Lead Gen Test 2 | Leads (native form) | {alt offer} | $20-50 | planned |
| Retargeting | Leads or Traffic | Social proof | $10-20 | after test |

### 2.2 Offer Creation

For each offer, create a file in `offers/{offer-name}.md`:

- **Offer name** — what the prospect receives
- **Offer position** on the spectrum (where does it sit?)
- **Why this offer** — based on competitive research, what gap does it fill?
- **What the prospect gets** — specific deliverable (quote, guide, consultation, assessment)
- **What we ask for** — form fields (name, email, phone, qualifying questions)
- **Perceived value** — how valuable does this feel to the prospect?
- **Urgency element** — time limit, limited spots, seasonal, etc. (optional, don't force it)

### 2.3 Ad Creative Development

Create ad creatives in `creatives/`:

#### Copy Templates (`creatives/copy-templates.md`)
Write 3-5 variations of ad copy for A/B testing:

Each copy variant includes:
- **Primary text** (body copy above the image/video) — 2-4 short paragraphs or bullet points
- **Headline** (below the image) — 5-10 words max, benefit-driven
- **Description** (optional subtitle) — one line reinforcing the headline
- **CTA button** — "Learn More", "Sign Up", "Get Quote", "Book Now"

Copy principles from competitive research:
- **Hook first** — the first line must stop the scroll (question, bold claim, pattern interrupt)
- **Agitate the problem** — remind them of their pain
- **Present the offer** — here is what you get
- **Social proof** — mention results, reviews, or numbers
- **Clear CTA** — exactly one thing to do next

#### Hooks (`creatives/hooks.md`)
Document 10-20 hook variations (first lines / first 3 seconds):
- Question hooks: "Still dealing with {pain point}?"
- Bold claim hooks: "We helped {X} businesses {result} in {timeframe}"
- Pattern interrupt: Start with something unexpected
- Social proof: "{X} five-star reviews and counting"
- Negative hooks: "Stop doing {common mistake}"

#### Image Specs (`creatives/image-specs.md`)
- **Dimensions**: 1080x1080 (square) or 1080x1350 (4:5 portrait, more screen real estate)
- **Text overlay**: keep under 20% of image area (Facebook penalizes heavy text)
- **Style**: based on winning patterns — UGC, professional, graphic, before/after
- **Variants**: create 3-5 image concepts for testing

#### Video Specs (`creatives/video-specs.md`)
- **Duration**: 15-30 seconds (short-form performs best)
- **Aspect ratio**: 9:16 (vertical) for Reels/Stories, 1:1 (square) for feed
- **Hook**: first 3 seconds must stop the scroll
- **Subtitles**: always — most people watch without sound
- **Structure**: Hook (3s) → Problem (5s) → Solution (10s) → Offer + CTA (5s)
- **Style**: UGC outperforms polished production in most niches

### 2.4 Lead Form Setup

For native Facebook lead form campaigns:

- **Form type**: "More volume" (pre-filled fields, lower friction) for testing; switch to "Higher intent" later
- **Questions**: name, email, phone + 1-2 qualifying questions from the lead-generation skill's form fields
- **TCPA consent**: include custom disclaimer for text/call consent
- **Thank you screen**: clear next-step instructions ("We will call you within 5 minutes")
- **Privacy policy**: link to business privacy policy (required)

### 2.5 Campaign Structure

For each campaign, create `campaigns/{campaign-name}/campaign-spec.md`:

#### Campaign Level
- **Objective**: Lead generation
- **Budget**: start $20-50/day per campaign
- **Campaign budget optimization (CBO)**: ON — let Facebook distribute budget across ad sets

#### Ad Set Level
- **Targeting**: start BROAD — one ad set with:
  - Location: business service area
  - Age: based on ICP (or 25-65 if broad)
  - Gender: all (unless ICP is heavily skewed)
  - Detailed targeting: NONE to start — let the algorithm find people based on creative
  - Placements: Automatic (Facebook, Instagram, Audience Network)
- **Why broad targeting**: Facebook's algorithm is better at finding buyers than manual targeting. Let the creative do the targeting.
- **Optimization**: optimize for Leads (form submissions)

#### Ad Level
- **3-5 ad variations** per ad set (different copy + creative combinations)
- **Dynamic creative**: consider turning ON to let Facebook mix and match headlines, images, and copy
- Let run for 3-5 days before making changes (need statistical significance)

### Phase 2 Deliverables
- [ ] Campaign strategy documented
- [ ] Offers created and positioned on the spectrum
- [ ] Ad copy written (3-5 variations per campaign)
- [ ] Hooks documented (10-20 variations)
- [ ] Image creative specs/briefs created
- [ ] Video creative specs/briefs created
- [ ] Lead forms configured with qualifying questions and TCPA consent
- [ ] Campaign structure documented (campaign → ad set → ads)
- [ ] First campaign launched with $20-50/day budget
- [ ] Lead form submissions wired to CRM (Twenty) via n8n or Zapier

---

## Phase 3: Optimization & Scaling

### 3.1 Initial Testing Phase (Days 1-7)

During the first week, do NOT change anything unless:
- An ad has zero impressions (delivery issue)
- A critical error (broken link, wrong form, etc.)

Monitor daily:
- **CPM** (cost per 1000 impressions) — are ads being delivered?
- **CTR** (click-through rate) — are people engaging? Target > 1%
- **CPL** (cost per lead) — what does each lead cost?
- **Lead quality** — are leads answering the phone? Are they qualified?
- **Form completion rate** — are people starting but not finishing the form?

### 3.2 Optimization Decisions (After Day 7)

Create `tracking/optimization-log.md` to document every change and its result:

```
## Optimization Log

### YYYY-MM-DD — Decision
- **What changed**: {description}
- **Why**: {data that drove the decision}
- **Expected outcome**: {what we hope to see}
- **Actual outcome**: {fill in after 3-5 days}
```

#### Kill / Scale Framework
- **Kill** an ad if: CTR < 0.5% after 1000+ impressions, or CPL is 3x+ target after 5+ days
- **Scale** an ad if: CPL is at or below target AND lead quality is good
- **Iterate** if: CPL is close but not quite there — test new hooks, copy, or creative while keeping what works

#### What to Test (in order)
1. **Hooks** — swap the first line of copy or first 3 seconds of video
2. **Offers** — try a different position on the offer spectrum
3. **Creative format** — swap image for video or vice versa
4. **Ad copy body** — different angles on the same offer
5. **Audience** (last resort) — only if creative testing is exhausted

### 3.3 Transition to Landing Page Traffic

Once you have proven ads (good CTR, good CPL, good lead quality with native forms):

1. **Duplicate the winning campaign**
2. **Change objective** from Leads to Traffic/Conversions
3. **Point to the landing page** from the lead-generation skill
4. **Install Facebook Pixel** on all landing pages (should already be done from lead-generation skill's remarketing setup)
5. **Optimize for conversions** — tell Facebook to find people who will actually submit the form on your page
6. **Compare results** — landing page CPL vs native form CPL

The landing page may convert better or worse. Native forms have higher volume but sometimes lower quality. Landing pages have lower volume but can qualify better with more form steps.

### 3.4 Retargeting Campaigns

Set up retargeting for warm audiences:

- **Website visitors** — people who visited landing pages but didn't convert
- **Video viewers** — people who watched 50%+ of video ads
- **Form abandoners** — people who opened the lead form but didn't submit
- **Engaged social** — people who liked, commented, or shared posts/ads
- **Email list** — upload customer/lead lists as custom audiences

Retargeting creative should be different from cold traffic:
- Social proof heavy (testimonials, case studies, review screenshots)
- Urgency (limited time, limited spots)
- Different angle on the same offer
- Address objections directly

### 3.5 Scaling

Once campaigns are profitable:

#### Vertical Scaling
- Increase budget by 20-30% every 3-5 days (not all at once — Facebook's algorithm needs time to adjust)
- Monitor CPL after each increase — if it spikes, hold budget steady for a few more days

#### Horizontal Scaling
- Duplicate winning ad sets to test new audiences (lookalike audiences, different age ranges, new locations)
- Create new ad variations based on the winning hooks/offers
- Test new ad formats (if winning with images, test video; if winning with video, test carousels)

### Phase 3 Deliverables
- [ ] 7-day initial test completed without premature changes
- [ ] Optimization log started with data-driven decisions
- [ ] Underperforming ads killed, winning ads identified
- [ ] At least one round of hook/creative A/B testing completed
- [ ] Transition to landing page traffic tested (if native forms proved out)
- [ ] Retargeting campaigns set up for warm audiences
- [ ] Scaling strategy documented and initial budget increases applied
- [ ] Weekly reporting cadence established

---

## KPIs & Tracking

Create `tracking/kpis.md`:

| Metric | Target | Frequency |
|--------|--------|-----------|
| Cost per lead (CPL) | {industry benchmark} | Daily |
| Click-through rate (CTR) | > 1% | Daily |
| Cost per thousand impressions (CPM) | {varies by niche} | Daily |
| Lead form completion rate | > 30% | Daily |
| Lead-to-appointment rate | > 30% | Weekly |
| Appointment show-up rate | > 70% | Weekly |
| Cost per acquisition (CPA) | {business target} | Weekly |
| Return on ad spend (ROAS) | > 3x | Monthly |
| Ad frequency | < 3 (cold), < 6 (retarget) | Weekly |

Create weekly reports in `tracking/weekly-reports/`:
- Spend, leads, CPL, CTR, CPM for each campaign
- Top performing ad with screenshot/details
- Worst performing ad and why it was killed
- Optimization decisions made and results
- Next week plan

---

## Available Extensions & Tools

| Extension | Purpose | Category |
|-----------|---------|----------|
| **Meta Ads MCP** | Programmatic ad account management via API | Ad Management |
| **n8n** | Wire lead form submissions to CRM and follow-up sequences | Automation |
| **Twenty CRM** | Route and manage leads from ad campaigns | CRM |
| **Remotion** | Generate video ad creatives programmatically | Creative |
| **Postiz** | Organic social posts that complement paid campaigns | Social |

---

## Execution Order

1. **Competitive research first** — never run ads blind, understand the landscape
2. **Offer positioning** — find the sweet spot between volume and quality
3. **Creative development** — hooks, copy, images, video based on research
4. **Native lead form campaign first** — prove the ad works before adding landing page variables
5. **Optimize based on data** — kill losers, scale winners, test new variations
6. **Transition to landing pages** — once ads are proven, send traffic to funnels from lead-generation skill
7. **Retarget warm audiences** — capture people who engaged but didn't convert
8. **Scale what works** — increase budget gradually, expand audiences horizontally

## Integration Tools

```
integration_is_enabled({ integration_slug: "<slug>" })
integration_get_credentials({ integration_slug: "<slug>", include_secrets: true })
```

## Project Management

This is a **Large** project. Use the Full PRD template (Tier 3) from the project-management skill. Keep PROJECT.md updated as campaigns launch and optimize. Add to ACTIVE_PROJECTS.md.

If the marketing-plan or lead-generation projects already exist, link to them and import ICP research and funnel specs rather than duplicating.
