---
slug: sulla-build-extension
label: Route a Sulla extension request to the right builder
trigger_when: When someone says extension or add-on and you need to choose between a function hook, recipe service, integration package, UI contribution, or another Sulla plugin kind.
trigger_actions: [build extension, choose extension kind, extend Sulla]
trigger_phrases: [extension, add-on, Sulla extension, extend Sulla]
scope: [sulla-plugins, sulla-extensions]
---

**Do:**
1. Start with `sulla-build-a-plugin` to choose, scaffold, validate, install, test, and prepare submission.
2. Use `sulla-build-a-recipe` for a Docker Compose service.
3. Use `sulla-build-an-integration-package` for signed executable integration code with brokered HTTPS access.
4. Use `sulla-add-hooks-and-ui-to-sulla` for Extension Contract v1 hooks, filters, or declarative UI.
5. Use `sulla-build-function`, `sulla-build-workflow`, `sulla-create-agent`, or `sulla-create-skill` when that smaller kind is enough.

**Don't:** call every plugin a recipe. “Extension” is an umbrella term; the runtime and trust boundary depend on the chosen kind.
