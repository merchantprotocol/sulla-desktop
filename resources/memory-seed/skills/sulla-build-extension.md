---
slug: sulla-build-extension
label: Build a Sulla function or recipe extension
trigger_when: When an add-on needs Extension Contract v1 hooks, filters, declarative UI, a signed integration package, or a containerized recipe service.
trigger_actions: [build extension, add hook, build integration package, build recipe extension, add extension UI]
trigger_phrases: [extension, hook, filter, integration package, Extension Contract, recipe service]
scope: [sulla-extensions, sulla-marketplace]
---

**When:** Choose a function extension for bounded hooks or UI contributions; choose a recipe for a Docker/container service; choose an integration package only when brokered HTTPS access and a signed package boundary are required.

**Do:**
1. For a function, create a valid `function.yaml` with `apiVersion: sulla/v1`, `sullaApi: ^1.0.0`, a function `kind`, `id`, `slug`, `spec.runtime`, and `spec.entrypoint`; declare hooks as strings or `{name, priority, timeoutMs}`. Use the examples under `examples/use-cases/` as shape references.
2. For hooks, use only the supported names. Filters return `{value: ...}` or `{denied:true,reason}`; actions observe and return no replacement. Expect secret-redacted payloads and a bounded timeout.
3. For UI, declare `ui` contributions with slot `sidebar_entry`, `settings_tab`, or `chat_card`; each needs `id`, `label`, and `component`. Do not add renderer routes.
4. For a recipe, provide `installation.yaml` and `docker-compose.yml`; keep service data persistent and document ports, setup, and stop impact.
5. For an integration, include the signed `apiVersion: sulla/v1` manifest, semver version, permissions, entry file, HTTPS/localhost `baseUrls`, canonical integrity, Ed25519 publisher signature, and every allowed `proxyPaths` route. Entry code may call only `runtime.proxy({method,path,body})`.
6. Scaffold or validate with `sulla marketplace/scaffold '{"kind":"<kind>","slug":"<slug>"}'` and `sulla marketplace/validate '{"kind":"<kind>","slug":"<slug>"}'`. For workflows used by the extension, also run `sulla meta/validate_sulla_workflow`.
7. Test with synthetic data and least privilege. Request the human's grant for hooks or integration permissions; unsigned or untrusted integrations must fail closed.
8. After review, prepare the exact marketplace submission and ask once with `ask_user_question`; only after **Approve**, use `sulla marketplace/publish` for the local artifact, then verify it is `pending`; it is not live until marketplace approval.

**Don't:**
- Don't read vault credentials or environment secrets from an extension.
- Don't use undeclared proxy paths, request broad permissions, or treat a hook as an approval bypass.
- Don't publish `.env`, `.git`, `node_modules`, keys, or build output.
