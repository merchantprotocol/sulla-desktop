---
schemaversion: 1
slug: new-software-development-project
title: "New Software Development Project"
section: "Standard Operating Procedures"
category: "Software Development"
tags:
  - skill
  - software-development
  - coding
  - vibe-coding
order: 5
locked: true
author: seed
---

**Triggers**: Human says "new project", "build a new app", "start software project", "create software for", "build workflow for new project", "set up new application".

## Description

This skill is used when we want to start a new software project from scratch. It will help you decide which kind of project to start and what resources we have available for the projects.

## Environment

### Workspaces
Dedicated folders in user data dir for persistent files and dev work. Use create_workspace tool to make one per project. Store all code, assets, outputs here. Access via list/read tools. Execute commands only with full absolute paths (no ~ or relative). Ideal for software builds, downloads, data processing.

- use tool: "create_workspace" name: {slug} returns: {workspacePath} absolute path to workspace
- All files go here exclusively. Use full absolute paths only.
- Add a README.md which explains the project in detail
- use tool "article_update" to add workspace path

### Docker Environment
You run on Docker with full host access. Launch any safe container/image from internet. For dev: always mount workspace dir into container via docker-compose for hot reload (e.g., Node.js changes appear instantly on refresh).

- Create Dockerfile and docker-compose.yml in workspace root to deploy the webserver (prefer nodejs)
- docker-compose must volume-mount the entire workspace into container for live reload.
- Example for Node.js: mount {workspacePath}:/app, expose ports, run dev command.
- Launch container immediately.

### GitHub Repositories
We have full GitHub tool suite to create, clone, commit, push, open PRs, manage issues, and control any repository. Every single project MUST live in its own dedicated GitHub repo because all repositories are wired directly into our CI/CD rollout pipeline. Use GitHub tools as the primary storage and version-control layer for every skill, project, and asset.

- Init git repo in workspace.
- use tool: "github_create_repo" name: {slug} returns: {repoUrl}
- use tool: "github_init_repo" name: {slug}
- use tool: "github_add_remote" absolutePath: {workspacePath} remoteName:origin remoteUrl: {repoUrl}
- use tool "article_update" to add github information to project document
- Maintain main branch clean.

### Protocol
Open-source project we built and maintain at https://github.com/merchantprotocol/protocol. Install globally first. It is our Infrastructure-as-Code foundation that manages the entire Docker/container lifecycle for any project (local + production). Bake container definitions into the GitHub repo, handle environment-specific credentials, start/stop/restart containers, manage cron jobs, and replicate the full environment to any VPS. Always use Merchant Protocol when creating or updating project containers.

- check if protocol is available as a command line tool
- if not, then install it (curl -L "https://raw.githubusercontent.com/merchantprotocol/protocol/master/bin/install" | bash)
- initialize protocol in the workspace
- run `protocol start` to bootup the container
- provide a url to the human to view the project

### Deployment Platforms
For large-scale SaaS applications use Amazon Web Services (AWS) with full tool access (EC2, ECS, RDS, S3, Lambda, etc.). For smaller static websites or front-ends use Cloudflare Pages for instant global deployment, CDN, and zero-ops hosting. Choose the platform based on scale, cost, and requirements — always document the chosen platform and deployment steps in the skill.

### Project documentation
Documentation always exists in the /docs folder of the workspace. Create the documentation in markdown files.

## Resources

### SaaS Framework for Rapid Development
For SaaS projects that require team management, announcements, login/registration/pw resets, white labeling, affiliate management, onboarding, billing, invoicing, ledgers, integrations, etc. Merchant Protocol has built and maintains a SaaS framework that allows new projects to be up and running within a couple hours. We strongly suggest using this framework as it has a strong base and strong community. It comes preconfigured to work with Docker and Protocol.

### Sulla Plugin Development
The plugin system for Sulla Desktop allows you to keep your project in full compatibility with the Sulla Desktop core.

## PRD Template

The Planner must produce a PRD with this structure:

```yaml
---
schemaversion: 1
slug: software-project-name
title: "the name of this project"
section: "Projects"
category: "a related category"
tags:
  - software-development
order: 5
locked: false
author: sulla
---
```

Followed by:
- **Ultimate Project Goal**
- **Owner** and **Start Date**
- **User Stories** (as a ..., I want ..., so that ...)
- **Must Haves** / **Should Haves** / **Nice-to-Haves** (MoSCoW)
- **What Has Been Tried and Didn't Work**
- **Execution Checklist** (step-by-step, checkable)
