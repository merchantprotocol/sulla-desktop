---
schemaversion: 1
slug: skill-n8n-workflow-creation
title: "Create n8n Automation Workflow"
section: Standard Operating Procedures
category: Automation
tags:
  - skill
  - n8n
  - workflows
  - automation
order: 6
locked: true
author: seed
---

# Skill Manifest: Create n8n Automation Workflow

**Project article slug** = workflow-{purpose-kebab}

**Triggers**: Human says "build workflow", "create automation for", "set up n8n to do", "create n8n workflow", "automation for".

## Description

We have n8n installed as a docker container, it's our preferred system for setting up automations/workflows.

## Environment

### n8n
- n8n is installed locally on docker.
- n8n dashboard: http://127.0.0.1:30119
- n8n has a full API. Native tools are built around the n8n API in the n8n tool category.
- n8n is installed into the postgres database. Native pg tools are available.
- n8n operations are stateful — creating or updating workflows and credentials changes persisted data.
- Workflow payloads follow the n8n structure: nodes array, connections object, settings object.

### Node-specific workflow editing tools
- patch_workflow is the unified mutation tool for node and connection deltas (sequential, atomic).
- get_workflow_node_list returns lightweight node list + edge map.
- get_workflow_node returns node details by nodeId or nodeName.
- patch_workflow supports node operations: add, update, remove and connection operations: add, remove.

### Active Sidebar Elements
- Use manage_active_asset to create/update/remove active elements (iframe, document).
- For workflow SPA display, use the resolved stable workflow asset ID.
- Keep URL on the workflow app main/base route only.

### Chat Completions Endpoint
- Local: http://localhost:3000/v1/chat/completions
- Docker: http://host.docker.internal:3000/v1/chat/completions
- No authentication required.

### Integration Credentials
- integration_get_credentials returns connection status and stored values.
- n8n credentials managed through local credentials entity store.
- get_credentials lists, create_credential adds.

## Planner

After the universal core PRD sections (YAML frontmatter + Goal through What Has Been Tried), you MUST include:

- **Requirements** — Trigger type, Error handling strategy
- **Credential Resolution** — Markdown table: Integration | Required | Status | Notes
- **Workflow Details** — Workflow name, High-level node flow, Total nodes and connections
- **Execution Steps** — Incremental build plan, each step verified with get_workflow / get_workflow_node_list before proceeding

## Webhook-First Development Pattern (CRITICAL)

**Every new workflow MUST start with a Webhook trigger node.** This is non-negotiable during development.

Why: A webhook is the only trigger type you can fire on-demand via curl. Without it, you have no way to manually test the workflow during development.

### Build sequence:
1. Create the workflow with a **Webhook** node as the first/trigger node.
2. Activate the workflow so the webhook URL becomes live.
3. Add processing nodes one at a time, verifying each by curling the webhook.
4. Add error handling + fallback nodes.
5. Test the full end-to-end flow by curling the webhook with realistic payload data.
6. **Only after everything works**: if the final trigger should be something else (cron/schedule, app event, polling, etc.), add that trigger node alongside the webhook or swap it out.

### Testing via webhook:
- After activating, use `diagnose_webhook` to confirm the webhook URL is reachable.
- Trigger the workflow with curl: `curl -X POST <webhook-url> -H "Content-Type: application/json" -d '{"test": true}'`
- Check execution results via `get_executions` or the n8n dashboard.

### Swapping to production trigger:
Once the workflow logic is fully tested and working:
- Add the desired production trigger (e.g., Schedule Trigger, App Trigger, etc.) using `patch_workflow`.
- You may keep the webhook node for future manual testing, or remove it.
- Re-verify the workflow executes correctly with the new trigger.

Each step must be completed and verified before the next begins.
