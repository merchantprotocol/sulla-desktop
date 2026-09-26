# First-time Installation Guide

This guide covers the **first-run setup wizard** after Sulla Desktop is already downloaded and launched.

## Step 1: Choose AI resource limits (Memory + CPU)

On the first screen, you choose how much system memory and CPU Sulla can use for AI services.

- These limits help prevent AI workloads from consuming all available machine resources.
- For systems at minimum spec, plan for at least **8 GB RAM** total on the machine.
- If your system is near minimum spec, keep allocations conservative so your OS and other apps stay responsive.

### Advanced settings on this step

#### Local model (advanced)

Local model selection is intended for advanced users.

- Local models usually require significantly more hardware for acceptable performance.
- For most users, a **remote model provider** is recommended for better quality and speed.

#### Kubernetes / k8s (advanced)

You can enable Kubernetes support during setup.

- Sulla is compatible with k8s.
- k8s requires additional CPU and memory.
- This is best for advanced users with larger machines.

## Step 2: Enter your user profile and credentials

Next, you will enter details such as:

- Name
- Email
- Password

How this is used:

- Your name helps personalize AI interactions.
- Your email and password are used for account and connected feature setup, including your integrations.

## Step 3: Configure your remote model provider

In this step, select a remote model provider and enter an API key.

- This is the main required setup for AI usage.
- You can use providers such as OpenAI or others.
- If cost is a priority, start with **Grok**.

### Grok quick setup

1. Open the xAI API Keys page directly: https://console.x.ai/team/default/api-keys
2. Create a new API key.
3. Copy the key into the Sulla setup wizard.
4. Choose your Grok model and continue.

For broader provider guidance, see:

- [Setting Up API Keys](../ai_configuration/setting-up-api-keys.md)
- [Choosing AI Models](../ai_configuration/choosing-ai-models.md)

## Step 4: Wait for first-run provisioning

After configuration, Sulla completes first-run setup automatically.

- Typical completion time is about **10 minutes or less**.
- The longest part is usually downloading required components, so total time depends on internet speed.
- This setup is typically done only once.

On future restarts, Sulla reuses installed components and starts normally without re-running full setup.

## If you need to change settings later

All of these settings can be updated later in Preferences, including AI model settings.

If you run a **Factory Reset**, the first-run setup wizard will appear again.

## Related guides

- [System Requirements Check](./system-requirements-check.md)
- [Updating to Latest Version](./updating-to-latest-version.md)
- [Uninstalling Sulla Desktop](./uninstalling-sulla-desktop.md)
