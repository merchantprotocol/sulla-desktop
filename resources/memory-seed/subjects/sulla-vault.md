---
slug: sulla-vault
kind: system
name: Sulla password vault
parent: sulla
aliases: [password vault, Sulla Vault, credentials, autofill, vault unlock]
---

## Overview
The Sulla Vault is the encrypted credential boundary for Desktop. It keeps integration credentials and Cloud session material in vault custody and brokers approved operations without exposing raw secrets to the agent. The vault must be unlocked for vault-gated services and can be locked again from the Password Vault UI. Access is policy-controlled per credential and operation.

## Facts
- The Password Vault UI is `pkg/sulla-desktop/pages/VaultPage.vue`; the global unlock surface is `pkg/sulla-desktop/pages/agent/VaultUnlockScreen.vue`.
- Locking the vault zeroes encryption keys from memory and removes agent access until unlock; the UI label is “Lock Vault”.
- Credential AI access levels are `none`, `metadata`, `autofill`, and `full`; the default policy is `autofill` when no valid stored level exists.
- Vault broker code is under `pkg/sulla-desktop/vault-broker`; Desktop and tool transports enforce caller identity, operation policy, and credential scope.
- Container-vault generic agent-browser autofill is intentionally unsupported by the broker; Desktop browser-tab autofill and the supported integration autofill flow route through the vault authority without returning the password to chat.
- Cloud session tokens, integration credentials, provider credentials, and relay credentials must remain in vault custody; agents receive only allowed metadata or brokered results.

## Rules
- DO: Unlock the vault through the Desktop unlock surface when a vault-gated service is waiting. Why: locked services cannot access credentials.
- DON'T: ask the agent to print, export, copy, or inspect raw secrets. Why: that defeats the vault boundary.
- DON'T: claim that “autofill” means the agent can read the password. Why: autofill is a narrower policy.
