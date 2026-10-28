---
slug: sulla-marketplace
kind: system
name: Sulla Marketplace
parent: sulla
aliases: [marketplace, catalog, add-ons, package catalog, Use Cases marketplace]
---

## Overview
The Sulla Marketplace is a catalog for workflows, agents, skills, functions, integrations, recipes, and packages (bundles of database-backed artifacts). Search and detail are available without signing in; publishing and submission history need a Sulla Cloud session. A non-package download is validated and installed into the Desktop database, while the agent-facing download path writes a draft into Sulla Files and requires human publication before activation. Package installs are atomic. Listings are not live until marketplace review approves them.

## Facts
- `marketplace/publish` submits a version for review; it never goes live directly. Automated review checks the per-kind manifest, package size, likely secrets and private keys, declared hooks and permissions, referenced network hosts and shell use. An administrator then approves, requests changes or rejects, and the notes appear in `marketplace/list_published`.
- Approval signs the exact approved manifest and package with the marketplace Ed25519 key. Installs verify the signature and integrity before writing anything; a tampered or untrusted signature is refused.
- Unsigned listings still install, with a logged warning, until `resources/trusted-integration-publishers.json` sets `"requireSignatures": true`. Local artifacts and unpublished development copies install through their local paths.
- Every update is a new reviewable version; users keep the last approved version until the update is approved.
- `marketplace/search` accepts `query`, one `kind`, multiple `kinds`, `category`, and `limit`; kinds include `workflow`/`routine`, `agent`, `skill`, `function`, `integration`, `recipe`, and `package`.
- `marketplace/info` accepts `kind` and `slug` and reports listing metadata plus local install status.
- `marketplace/download` accepts `kind`, `slug`, and optional `overwrite`; package installs all contents transactionally, while standalone downloads are returned as Files drafts to the agent.
- `marketplace/update` replaces an installed marketplace artifact in place and restores it if the update fails; use `marketplace/diff` first to see local edits that would be overwritten.
- `marketplace/validate` checks the local artifact; workflows also need `meta/validate_sulla_workflow` for full schema and reachability checks.
- `marketplace/publish` submits a local database artifact or package and uploads a generated manifest and bundle; it needs a Sulla Cloud session and reports `pending` until an administrator approves it.
- Marketplace artifact kinds map to local primary files: skill `SKILL.md`, workflow `routine.yaml`, function `function.yaml`, recipe `installation.yaml`, integration `integration.yaml` or a versioned integration manifest, and agent `agent.json` when exported.
- Signed integration packages are checked for `apiVersion: sulla/v1`, integrity, Ed25519 signature, declared permissions, and declared proxy paths before immutable persistence; an ungranted package is not loaded.

## Rules
- DO: Search, inspect detail, validate, then install. Why: a catalog result is not enough evidence of fit or safety.
- DO: Read the install result and verify local status before using an artifact. Why: package contents may be skipped with warnings and standalone downloads may still be drafts.
- DON'T: treat `pending` as public or approved. Why: marketplace review controls activation.
- DON'T: overwrite local edits without first running `marketplace/diff`. Why: update replaces the local copy.
- DON'T: bypass signature, integrity, permission, or human-approval checks. Why: those checks are the trust boundary.
- DON'T: include `.env`, keys, credentials, `.git`, `node_modules`, or build output when publishing. Why: the publish pipeline excludes secrets and junk.
