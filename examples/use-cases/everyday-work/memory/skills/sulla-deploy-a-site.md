---
slug: sulla-deploy-a-site
label: Deploy and verify a website or web app
trigger_when: When someone asks you to deploy a site to staging or production, protect staging, automate deploys from GitHub, point a domain, or prove what is live.
trigger_actions: [deploy a website, deploy to staging, verify production, protect staging, configure a domain]
trigger_phrases: [deploy this website, get this out to staging, is this live in production yet, put this site behind a password, point my domain at the new site, set up a GitHub Action that deploys, deployed site throws an error]
scope: [everyday-work, tool-github, tool-browser, tool-vault]
---

**When:** Use this for a hosting deployment through GitHub Actions or a connected provider such as Cloudflare, Vercel, Netlify, Render, or Fly.io. Provider APIs differ; discover the connected integration instead of inventing an endpoint.

**Do:**
1. Read the repository's deployment docs and existing workflow files. Identify the environment, build output, secrets, health URL, rollback target, domain, and whether the requested provider is already configured.
2. Check the provider without exposing credentials: `sulla vault/is_enabled '{"account_type":"<provider>"}'` and `sulla vault/list_accounts '{"account_type":"<provider>"}'`. If it is not connected, open Integrations with `sulla ui/open_tab '{"mode":"integrations"}'` and explain which provider and scopes the human must connect. Do not claim deployment is possible until it is connected.
3. Discover the installed provider proxy with `sulla meta/browse_tools '{"query":"<provider> deploy domain password protection"}'`. Call only the returned form, such as `sulla <account-id>/<slug> '{"method":"GET","path":"<verified-provider-path>"}'`. For a generic owner-configured API item, resolve it with `sulla vault/list_api_keys '{}'` and call `sulla vault/request '{"item":"<item-id>","method":"GET","url":"https://<allowed-host>/<verified-path>"}'`.
4. Before changing a live service or DNS, record the current deployment identifier, configuration, DNS record values and TTL. This is the restore point. Prefer an immutable deployment or preview URL before moving production traffic.
5. For deploy-on-merge, make a normal code branch and add a workflow under `.github/workflows/` using the provider's current documented action and repository secrets. Give it `push` on the intended branch and `workflow_dispatch`; pin actions to a stable version or commit. Ship this change with `sulla-ship-a-code-change`.
6. Trigger an existing manual workflow with `sulla github/trigger_workflow_run '{"owner":"<owner>","repo":"<repo>","workflow_id":"<workflow-file>","ref":"<branch>","inputs":{"environment":"staging"}}'`. Then inspect the resulting ref with `sulla github/check_runs '{"owner":"<owner>","repo":"<repo>","ref":"<branch>"}'` and failures with `sulla github/ci_logs '{"owner":"<owner>","repo":"<repo>","ref":"<branch>","failedOnly":true,"maxLines":120}'`.
7. For staging protection, use the provider's verified access-control feature. Confirm it protects the staging hostname but does not block the production hostname or health checks. If the connected plan or API has no password/access-control feature, say so; do not substitute security by obscurity.
8. For a domain, verify the provider's required record first, compare it with the saved current records, apply only that record through the verified provider integration, and retain the old value for rollback. DNS changes are reversible but high-impact; verify both old and new targets before writing.
9. Open the deployed URL: `sulla browser/tab '{"action":"upsert","url":"https://<deployed-host>/"}'`. Inspect it visually with `sulla browser/screenshot '{}'` and watch failures with `sulla browser/monitor_network '{"action":"watch_errors","durationSeconds":15,"urlFilter":"<deployed-host>"}'`. Exercise the health path and one critical user path.
10. Compare the deployed version marker or commit SHA with the intended SHA. If verification fails, use the recorded provider deployment or DNS values to roll back, then re-run the same checks.

**Check:** The hosting provider reports a successful deployment for the intended commit, the public or protected URL returns the expected app, critical browser requests succeed, and the live version marker matches the intended SHA.

**Don't:**
- Don't guess provider API paths, DNS targets, project IDs, secret names, or plan capabilities. Discover them from the live catalog and provider response.
- Don't paste tokens into workflow files or chat. Store repository secrets through the provider or GitHub UI/integration.
- Don't say a domain is live from a successful deploy alone; verify DNS and the actual hostname.
- Don't delete deployments or DNS records. Deletion waits for explicit human approval through `ask_user_question`.
