---
slug: sulla-build-function
label: Build and run a custom function
trigger_when: When a user wants a reusable Python, Node, or shell function.
trigger_actions: [scaffold function, edit function, validate function, run function]
trigger_phrases: [build a function, custom function, run my function]
scope: [sulla-functions]
---

**Do:**
1. Confirm inputs, outputs, and runtime.
2. Scaffold with `sulla marketplace/scaffold '{"kind":"function","slug":"<slug>","runtime":"python"}'`.
3. Edit the generated `function.yaml` and handler, then validate with `sulla marketplace/validate '{"kind":"function","slug":"<slug>"}'`.
4. Run a safe minimal case: `sulla function/run '{"slug":"<slug>","inputs":{}}'`.
5. Inspect failures with `sulla function/runs '{"slug":"<slug>","only_failures":true,"verbose":true}'`.

**Don't:**
- assume schema validation proves handler output shape.
- put secrets in source or test inputs.
