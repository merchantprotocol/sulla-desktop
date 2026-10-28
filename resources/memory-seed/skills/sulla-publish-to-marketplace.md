---
slug: sulla-publish-to-marketplace
label: Submit a reviewed artifact to the Sulla Marketplace
trigger_when: When an approved local use case, extension, recipe, integration, or package should be submitted for marketplace review.
trigger_actions: [submit to marketplace, publish marketplace listing, distribute use case, publish extension]
trigger_phrases: [submit marketplace listing, publish to marketplace, distribute my use case, marketplace submission]
scope: [sulla-marketplace, sulla-use-cases]
---

**Do:**
1. Confirm the local artifact is active/reviewed and validate it: `sulla marketplace/validate '{"kind":"<kind>","slug":"<slug>"}'`.
2. Remove secrets and junk; agents are exported from the database and other kinds are materialized from the local artifact. The publisher pipeline excludes `.env`, `.git`, `node_modules`, keys, and build output, but inspect anyway.
3. Prepare the exact kind, slug, version, title, description, included files and a privacy check, then ask once: `sulla meta/ask_user_question '{"questions":[{"header":"Submit listing","question":"Submit this reviewed artifact to the Sulla Marketplace?","options":[{"label":"Approve","description":"Submit exactly this artifact for marketplace review."},{"label":"Deny","description":"Keep it local and submit nothing."}]}]}'`. Only after **Approve**, submit with a Cloud session: `sulla marketplace/publish '{"kind":"<kind>","slug":"<slug>","version":"<semver>"}'`. For a package, include its title, description, and `items` instead.
4. Check the response and then run `sulla marketplace/list_published '{}'`. The result is `pending` until administrator review; only an approved listing is live.
5. Keep the local copy. Marketplace unpublish does not delete it; it requires `confirm:true` and is a separate outward-facing action.

**Don't:** claim publication is live before approval, bypass review/signature checks, or upload private data.
