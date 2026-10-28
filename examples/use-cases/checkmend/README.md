# Checkmend

**Listing:** Checkmend — *Fix a failing CI check from its logs* — Trace a GitHub Actions failure to its cause, make the smallest fix, and verify the check.

Checkmend reads the current PR and GitHub Actions evidence, isolates the first actionable failure, forms one testable hypothesis, and guides a minimal repair without weakening CI.

## Setup
Connect GitHub through the Sulla vault with read access to the repository and Actions checks. Write access is needed only for an approved push or workflow trigger. External CI providers are not queried beyond the details GitHub exposes.

## Use and customize
Provide a PR URL or repository and branch. Customize the allowed local verification commands through the repository's own instructions. Keep log excerpts bounded and redact secrets. Any push, PR comment, workflow trigger, rerun, or merge waits for human approval.

Adapted from `skills/.curated/gh-fix-ci` in openai/skills (OpenAI). Apache License 2.0. Modified for Sulla Desktop.
