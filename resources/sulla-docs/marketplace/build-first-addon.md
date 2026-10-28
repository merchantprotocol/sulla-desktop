# Build your first Sulla add-on

Sulla add-ons are small, reviewable bundles that extend the assistant without changing core. Start with the smallest kind that solves the job, keep permissions explicit, and test locally before you submit.

## Pick a kind

| Kind | What it adds | Use it when |
|---|---|---|
| **Skill** | Markdown instructions | You need reusable guidance, voice, or a procedure; no executable code. |
| **Function** | A Python, Node, or shell handler with typed inputs/outputs | You need deterministic code, transformation, or a narrow API. |
| **Workflow** | A YAML graph of triggers and steps | You need orchestration, schedules, approvals, retries, or multiple tools. |
| **Recipe** | A Docker Compose service plus an installation manifest | You need to run a self-contained local service in Sulla's VM. |
| **Integration** | Versioned auth and endpoint manifests | You need to describe a service connection for agents to call. |
| **Agent** | A named prompt, tools, and model configuration | You need a specialized assistant with a distinct role. Agents can be created locally; they are not currently published through the marketplace. |

See [`examples/extensions/`](../../../examples/extensions/) for minimal hello-world bundles.

## The afternoon path

### 1. Scaffold

Use the CLI tool rather than copying an old bundle:

```bash
sulla marketplace/scaffold '{"kind":"function","slug":"my-helper","name":"My helper","description":"Does one small thing","runtime":"python"}'
```

`kind` accepts `workflow` and the older alias `routine`. Function runtimes are `python`, `node`, or `shell`. Slugs are lowercase kebab-case. The scaffold creates a local database draft (or a draft workflow); edit the generated files and replace every TODO. It does not publish or send anything.

For a hand-authored bundle, keep the kind's required files together:

- skill: `SKILL.md`
- function: `function.yaml` and its entrypoint
- workflow: `routine.yaml`
- recipe: `installation.yaml` and `docker-compose.yml`
- integration: `<slug>.v<N>-auth.yaml` plus one or more `<name>.v<N>.yaml` endpoint files
- agent: create it in the Agents area, then export its `sulla/v3` manifest

### 2. Validate early

```bash
sulla marketplace/validate '{"kind":"function","slug":"my-helper"}'
```

Validation reads the saved local artifact and reports actionable errors: missing fields, slug mismatches, missing entrypoints or compose files, invalid auth shapes, and malformed workflow structure. A workflow passing this check should also be checked with `sulla meta/validate_sulla_workflow` for reachability and the full graph schema. Validation never grants permissions and never publishes.

### 3. Test locally

Run the handler with representative inputs and verify its JSON output. Exercise empty, malformed, and boundary inputs. For workflows, run a draft manually and check every approval and failure path. For recipes, use a disposable service and confirm start, status, logs, restart, and stop; do not use real credentials in examples. For integrations, test against a test account or fixture and confirm the least-privilege auth and endpoint methods.

The hello-world bundles are intentionally safe fixtures. They live under `examples/extensions/` and are useful for smoke checks, not production defaults.

### 4. Publish for review

When the bundle is ready, inspect the files and version it:

```bash
sulla marketplace/publish '{"kind":"function","slug":"my-helper","version":"1.0.0"}'
sulla marketplace/list_published '{}'
```

Publishing requires a Sulla Cloud session and submits the bundle for review. The marketplace excludes secrets, `.env` files, keys, dependency caches, and build junk. Publishing is outward-facing; make sure the human owner has approved the submission.

## How review works

A submission starts as **pending**. Review checks that the manifest matches the files, the entrypoint or compose stack is real, permissions are no broader than necessary, metadata is honest, and the bundle does not contain secrets or unrelated files. Reviewers may request changes; update the local version and submit again. Only an approved submission becomes **live**. `agent` remains local-only for now.

Add-ons run within Sulla's existing VM, vault, Files, and tool-permission boundaries. An add-on never receives more access than the user granted to Sulla.

## Hooks

See the [Extension Contract v1](../extensions.md) for the stable hook list, grants, redaction, and compatibility policy. Function add-ons are executable hook handlers:

```yaml
sullaApi: ^1.0.0
hooks:
  - name: on_memory_write
    priority: 10
    timeoutMs: 1000
```

Skills, workflows, and recipes may declare a hook only by referencing an installed function handler; validation rejects declarations without `function: <slug>`.

## Troubleshooting

- **Unknown kind:** use `workflow`, not `routine`, in new bundles; both are accepted by the CLI.
- **Entrypoint missing:** make `spec.entrypoint` point to a file included beside `function.yaml`, using `file::handler` for Python or Node.
- **Recipe fails validation:** `installation.yaml` is the recipe manifest and must include `slug`, `version`, and a compose file that exists in the bundle.
- **Integration auth filename rejected:** use exactly `<slug>.v<N>-auth.yaml`; endpoint files use `<name>.v<N>.yaml`.
- **Publish unavailable:** sign in to Sulla Cloud; local scaffold and validation still work without a marketplace submission.

## How review works

Every new submission and every version update starts in **Pending**. The marketplace backend validates the kind-specific manifest, enforces package size limits, scans for likely credentials and private keys, and records declared hooks, permissions, network hosts, and shell-use risk flags. A failed automated review cannot be approved.

A Sulla Cloud administrator reviews that report and the submitted file inventory, then chooses **Approve**, **Request changes**, or **Reject**. Review notes appear in `sulla marketplace/list_published '{}'` so the author knows what to fix. Requesting changes or rejecting never makes the submitted version available to users.

Approval signs the exact approved manifest and package bytes with the marketplace Ed25519 key. The private key exists only in the Worker secret `MARKETPLACE_SIGNING_KEY`; it is never stored in a repository or Desktop build. Desktop verifies the integrity hash and signature before installing marketplace skills, functions, workflows, recipes, agents, integrations, and packages. Unsigned or changed marketplace downloads are refused. Local unpublished artifacts are not affected.

An update is a new reviewable version. Existing users continue to receive the last approved version until the update is approved.
