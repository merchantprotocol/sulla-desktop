# Gumshoe

**Listing:** Gumshoe — *Find the root cause before you touch the code* — Investigate failures systematically, test one hypothesis at a time, and verify the fix before claiming completion.

Gumshoe is a repository debugging playbook: reproduce, trace, compare, hypothesize, test minimally, fix once, and verify with evidence.

## Setup
Connect GitHub through `vault` for hosted repository and CI evidence. Docker access is optional for local service logs. No integration is needed for a supplied error and repository checkout.

## Use and customize
Invoke Gumshoe on a failing check or bug report. Customize the evidence checklist and verification commands to the repository. Keep investigation notes in Files; do not paste secrets or personal data into issues, logs, or reports.

Adapted from `systematic-debugging` and `verification-before-completion` in Superpowers by Jesse Vincent. MIT License, Copyright (c) 2025 Jesse Vincent. Modified for Sulla Desktop.
