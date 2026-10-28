---
slug: sulla-build-extension
label: Build a Sulla extension
trigger_when: When an add-on needs Extension Contract v1 hooks, filters, UI contributions, or a signed integration package.
trigger_actions: [build extension, add hook, build integration package]
trigger_phrases: [extension, hook, filter, integration package, Extension Contract]
scope: [sulla-extensions]
---

**Do:**
1. Declare `sullaApi: ^1.0.0` and request only needed hooks, permissions, UI slots, URLs, and OAuth scopes.
2. Use hooks exactly as documented; filters return a replacement or `{denied:true,reason}`, actions observe only.
3. For integrations, include signed `apiVersion: sulla/v1` manifest metadata, canonical integrity, publisher signature, and declared proxy paths.
4. Expose network access only through `runtime.proxy({method,path,body})`; validate with `sulla marketplace/validate '{"kind":"integration","slug":"<slug>"}'`.

**Don't:** read vault credentials, use undeclared proxy paths, or add renderer routes directly.
