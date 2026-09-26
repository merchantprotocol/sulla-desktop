# Connecting External Services

This guide explains how to connect external services so your Sulla automations can use them.

## Recommended method: add credentials in Integrations

The easiest and most scalable way to connect services is to add your credentials in the **Integrations** page.

When you connect services there:

- Your credentials become available to your AI executive assistant
- The language model can use those credentials to help configure automation/workflow service connections
- You avoid manually reconnecting every service step-by-step for each workflow

## Where to do this

1. Open **Integrations** in Sulla Desktop.
2. Select the external service you want to connect.
3. Add the required credentials/API key.
4. Save the integration.

Once saved, those credentials can be used by your automation setup flows.

## Why this helps your automations

Centralized credentials make workflow setup faster:

- Fewer manual connection steps
- More consistent service access across workflows
- Easier reuse when your assistant creates or updates automations

## If a service requires direct login

Some providers require an interactive login/authorization step (for example OAuth consent).

In those cases:

1. Start from **Integrations** as usual.
2. Complete the provider login/authorization flow.
3. Finish saving the connection.

After authorization is complete, the credentials can still be reused for automation and workflow setup.

## Best practice

Connect services in Integrations first, then build automations. This gives your assistant the credential access it needs to configure external service connections more automatically.
