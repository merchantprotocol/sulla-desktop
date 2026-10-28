# Porchlight

Porchlight reviews new inbound inquiries, ranks urgency from explicit buying signals, checks real calendar availability, and prepares reply drafts. The weekday workflow never sends or changes source messages.

## Setup
Connect an email integration with read access for automation. Calendar read access is recommended. Slack and a CRM are optional and remain approval-gated. Pasted messages or a CSV work without an integration.

## Use and customize
Run the skill for one lead or install the workflow for a weekday 7:00 AM review. Change the schedule and timezone in `routine.yaml`. Every reply, CRM write, Slack post, or booking still needs human approval.

Adapted from `small-business/skills/speed-to-lead` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
