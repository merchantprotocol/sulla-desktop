---
slug: sulla-manage-vault
label: Use Sulla vault credentials safely
trigger_when: When a user wants to connect a service, store a credential, autofill a password, or check integration state.
trigger_actions: [connect integration, save credential, autofill password, check vault]
trigger_phrases: [vault, password, API key, connect Slack, OAuth]
scope: [sulla-tools]
---

**Do:**
1. For OAuth, direct the human to Settings and never pretend the agent completed the login.
2. Check account state with `sulla vault/list_accounts '{"account_type":"<type>"}'` or `sulla vault/is_enabled '{"account_type":"<type>"}'`.
3. Use proxy calls so vault injection keeps secrets out of prompts and output.
4. Autofill with `sulla vault/autofill '{"origin":"https://example.com"}'`; the password must not return to chat.
5. Before deleting a credential, use `sulla vault/delete_credential` only with its required confirmation.

**Don't:**
- print, quote, export, or cite a credential, token, password, or secret.
- invent an OAuth completion or backup/export feature.
