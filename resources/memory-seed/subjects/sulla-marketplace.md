---
slug: sulla-marketplace
kind: system
name: Sulla Marketplace
parent: sulla
aliases: [marketplace, catalog, add-ons, package catalog]
---

## Overview
The Sulla Marketplace catalogs versioned use cases and add-ons. Search and info work without sign-in; download installs a listing through the Use Cases installer. Scaffold and validate operate on local artifacts. Publish submits a listing for review and requires a Sulla Cloud session; a submission is not live until approved.

## Facts
- `marketplace/search` filters by text, kind or kinds, category, and limit.
- `marketplace/info` accepts `kind` and `slug` and reports listing metadata and local install status.
- `marketplace/scaffold` accepts kind, kebab-case slug, optional name/description, and function runtime `python`, `node`, or `shell`.
- `marketplace/validate` checks local artifacts; workflows also need `meta/validate_sulla_workflow`.
- `marketplace/download` accepts kind, slug, and optional `overwrite`; packages install all embedded items atomically.
- `marketplace/publish` accepts kind, slug, and optional version; review approval is required before a listing is live.

## Rules
- DO: Inspect and validate an artifact before publishing. Why: publication is outward-facing.
- DON'T: include `.env`, keys, credentials, `.git`, `node_modules`, or build output. Why: the publish pipeline excludes secrets and junk and they do not belong in a bundle.
- DON'T: claim a pending submission is public or live. Why: catalog review controls activation.
