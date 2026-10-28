---
slug: sulla-evaluate-business-idea
label: Evaluate a business idea with evidence and a small test
trigger_when: When the human asks whether a business idea is worth pursuing, wants market evidence, or needs a practical validation plan before investing heavily.
trigger_actions: [evaluate business idea, research demand, compare competitors, design validation test]
trigger_phrases: [is this business idea worth it, run the numbers, validate this idea, research demand, size this opportunity, compare competitors, should I build this business]
scope: [everyday-work, sulla-files, tool-browser]
---

**When:** Produce an evidence-based decision brief, not false certainty. Use `sulla-plan-and-make-content` later for go-to-market work.

**Do:**
1. State the customer, painful job, proposed offer, price hypothesis, acquisition path, constraints, and the decision the brief must support.
2. Search the human's existing work with `sulla files/search '{"query":"<idea or market>"}'` before doing new research.
3. Research primary and independent sources with `sulla browser/background_browse '{"url":"<https-url>"}'`. For each important claim, record source, publication date, geography, sample or method, and what it actually proves. Cross-check market and competitor claims.
4. Build a transparent model: reachable customers × plausible conversion × price, then subtract direct costs, acquisition cost, refunds, support, and operating constraints. Show low, base, and high assumptions; never present a top-down market total as reachable revenue.
5. Map direct alternatives, substitutes, switching costs, distribution access, regulation, and reasons customers may do nothing. Separate observed evidence, estimates, and unknowns.
6. Recommend the smallest reversible test that can disprove the riskiest assumption: interviews, concierge delivery, landing-page interest, preorder only with appropriate approval, or a manual pilot. Define threshold, cost cap, duration, and stop rule before running it.
7. Save a cited brief through `sulla-save-work-in-files` with recommendation, evidence, model, uncertainties, test plan, and decision criteria.

**Check:** Every consequential claim has a traceable source or is labeled an assumption; arithmetic is reproducible; the recommendation follows the stated thresholds.

**Cleanup:** Remove downloaded pages and calculation scratch after the brief is checked. Keep only the useful model and cited brief.

**Traps:** Do not fabricate market size, demand, margins, or customer intent. Do not buy ads, charge cards, collect preorders, message prospects, or post a landing page without the human's explicit go-ahead.
