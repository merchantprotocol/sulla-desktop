# Threatline

**Listing:** Threatline — *Threat-model a repo before an attacker does* — Map trust boundaries and realistic abuse paths into an evidence-backed mitigation plan.

Threatline reads a local repository or vault-connected GitHub source at a specific commit, models data flows and trust boundaries, ranks realistic abuse paths, and writes a concise Markdown mitigation plan with evidence.

## Setup
No integration is required for a local repository. Connect GitHub through the Sulla vault for private remote repositories and grant read-only access. Provide deployment, exposure, authentication, tenancy, and data-sensitivity context when known.

## Use and customize
Name the repository or path to model and the deployment context. Customize the risk rubric for the organization, but keep evidence citations, explicit assumptions, attacker non-capabilities, and the separation of existing controls from proposed mitigations. Posting findings or opening issues waits for human approval.

Adapted from `skills/.curated/security-threat-model` in openai/skills (OpenAI). Apache License 2.0. Modified for Sulla Desktop.
