---
slug: sulla-make-images-and-video
label: Make images and short explainer videos with connected media tools
trigger_when: When the human asks for an image for a post, a short explainer video, voiceover, or generated media saved as a deliverable.
trigger_actions: [generate image, make post image, make explainer video, create voiceover]
trigger_phrases: [make me an image for this post, make a short explainer video, generate an image, create a video, make a voiceover, social graphic]
scope: [everyday-work, tool-vault, sulla-files]
---

**When:** Produce a media asset through a connected provider. Sulla does not include a provider-independent image or video generator; use only operations exposed by the connected integration.

**Do:**
1. Write the asset brief: purpose, audience, format, dimensions or duration, brand references, required text, exclusions, and delivery filename. For video, add hook, scene list, narration, captions, CTA, and timing.
2. Find a destination before generating: `sulla files/where '{"what":"generated campaign media","kind":"image or video"}'` and `sulla files/search '{"query":"<campaign asset name>"}'`.
3. Check a suitable integration, for example `sulla vault/is_enabled '{"account_type":"stability_ai"}'`, `sulla vault/is_enabled '{"account_type":"replicate"}'`, or `sulla vault/is_enabled '{"account_type":"elevenlabs"}'`. List configured accounts with `sulla vault/list_accounts '{"account_type":"<account-type>"}'`.
4. If none is connected, open Integrations with `sulla ui/open_tab '{"mode":"integrations"}'` and state the honest alternative: deliver the finished prompt, storyboard, script, shot list, and export specification for the human to use elsewhere.
5. Discover the provider's current operation: `sulla meta/browse_tools '{"query":"<account-type> generate image"}'` or `sulla meta/browse_tools '{"query":"<account-type> generate video"}'`. Call only the returned proxy or MCP command. Never invent an endpoint or put an API key in a shell command.
6. Generate a low-cost preview first when supported. Inspect composition, spelling, logo treatment, aspect ratio, continuity, captions, audio level, and factual accuracy. Regenerate only for a named defect.
7. Save the selected binary to the canonical Files path with a clear extension. Save the final script or prompt beside it only when it is a useful human deliverable, not agent scratch.
8. Read back file metadata and confirm the asset opens, has the requested format and dimensions or duration, and contains no placeholder material.
9. Uploading or posting is external publication. Prepare the exact channel call and ask once with `sulla meta/ask_user_question '{"questions":[{"header":"Publish media","question":"Publish the reviewed asset to the shown destination?","options":[{"label":"Approve","description":"Publish this exact asset."},{"label":"Deny","description":"Keep it in Files only."}]}]}'`. Publish only after **Approve**.

**Check:** Open the selected file and verify format, dimensions or duration, legible text and captions, audible narration when present, and the requested destination. Distinguish a prompt, preview, rendered file, and published asset.

**Cleanup:** Remove rejected previews and provider downloads from scratch. Do not delete existing human assets. Keep only the selected deliverables in Files.

**Traps:** Do not claim a video was rendered when only a script exists. Do not imitate a living artist, fabricate people or endorsements, use unlicensed brand assets, expose provider secrets, or publish without approval.
