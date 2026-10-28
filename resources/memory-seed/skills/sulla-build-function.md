---
slug: sulla-build-function
label: Build and run a Sulla function
trigger_when: When you need deterministic typed code in Python, Node, or shell instead of an agent or workflow graph.
trigger_actions: [build function, create custom function, run function]
trigger_phrases: [custom function, function.yaml, deterministic handler]
scope: [sulla-functions]
---

**Do:**
1. Scaffold: `sulla marketplace/scaffold '{"kind":"function","slug":"<kebab-slug>","name":"<name>","description":"<description>","runtime":"python"}'`.
2. Define `apiVersion: sulla/v1`, `kind: Function`, identity fields, and `spec.runtime`, `entrypoint`, typed `inputs`, typed `outputs`, `timeout`, and least-privilege `permissions`.
3. Implement the declared handler (`file::handler`), then validate: `sulla marketplace/validate '{"kind":"function","slug":"<slug>"}'`.
4. Run with `sulla function/function_run '{"slug":"<slug>","inputs":{}}'`; inspect failures with `sulla function/function_runs '{"slug":"<slug>","only_failures":true}'`.

**Don't:** put credentials in code or assume workflow node settings select the function runtime.
