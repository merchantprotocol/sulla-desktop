# Clickpath

**Listing:** Clickpath — *Test your web app the way a real user would* — Exercise critical browser journeys, capture evidence, and report reproducible UI failures.

Clickpath uses Sulla's browser, network-error monitor, and screenshots to verify critical journeys in a local or staged web app. It produces reproducible failures without installing Playwright in the target repository.

## Setup
No outside integration is required. Start the application with its documented local or container command and provide a safe base URL plus a synthetic test account if authentication is in scope.

## Use and customize
Name the critical journeys and their success criteria. Customize the viewport matrix and priority paths for the product. Use a sandbox for sends, posts, payments, and deletion; a real irreversible action always waits for human approval.

Adapted from `skills/webapp-testing` in anthropics/skills, Copyright Anthropic, PBC. Apache License 2.0. Modified for Sulla Desktop.
