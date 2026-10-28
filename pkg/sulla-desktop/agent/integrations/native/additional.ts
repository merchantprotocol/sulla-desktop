// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/* eslint-disable */
// Hard-coded integration definitions that are newer than (or missing from) the
// per-category files in this folder: azure_devops, forgejo, gitea, meta-ads, n8n
// (new) and bitbucket, cloudflare, cohere, gitlab, google_drive, openai, r2
// (updated). Spread LAST in ./index.ts so these win by id.
import type { Integration } from '../types';

export const nativeAdditionalIntegrations: Record<string, Integration> = {
  "azure_devops": {
    "id": "azure_devops",
    "name": "Azure DevOps",
    "description": "Manage Azure Repos, pull requests, work items, builds, and releases for an Azure DevOps organization.",
    "category": "Developer Tools",
    "icon": "azure_devops.svg",
    "paid": false,
    "sort": 6,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-10-14",
    "developer": "Microsoft",
    "authType": "credentials",
    "formGuide": "Enter your Azure DevOps organization API URL and a personal access token. PATs use HTTP Basic authentication.",
    "installationGuide": {
      "title": "Connect Azure DevOps",
      "description": "Create a scoped Azure DevOps PAT and configure the organization endpoint.",
      "steps": [
        {
          "title": "Create a PAT",
          "content": "Open User settings → Personal access tokens, create a token, set an expiration date, and select only the scopes your automation needs."
        },
        {
          "title": "Choose scopes",
          "content": "Code Read for repository inspection, Code Write for pushes, Code PullRequest Read or Contribute for pull requests, Work Items Read or Read & Write for boards, and Build Read or Execute for pipelines."
        },
        {
          "title": "Configure the organization URL",
          "content": "Enter https://dev.azure.com/{organization} as the base URL. The proxy uses this stored URL literally."
        },
        {
          "title": "Save and test",
          "content": "Save the PAT and test with GET /_apis/projects?api-version=7.1-preview.1 through the integration proxy."
        }
      ],
      "importantNotes": [
        "Azure DevOps PATs authenticate with HTTP Basic using an empty username and the PAT as the password.",
        "The current transparent proxy injects bearer tokens and API keys, but not Basic credentials. See INTEGRATION.md for the exact app change required for PAT support."
      ]
    },
    "features": [
      {
        "title": "Azure Repos",
        "description": "Browse repositories, commits, branches, and file content."
      },
      {
        "title": "Pull Requests and Work Items",
        "description": "Review code and manage work-item workflows."
      },
      {
        "title": "Builds and Releases",
        "description": "Inspect and automate Azure Pipelines builds and releases."
      }
    ],
    "guideLinks": [
      {
        "title": "Azure DevOps REST API",
        "description": "Azure DevOps REST API 7.1 reference",
        "url": "https://learn.microsoft.com/en-us/rest/api/azure/devops/"
      },
      {
        "title": "Personal Access Tokens",
        "description": "Azure DevOps PAT creation and scopes",
        "url": "https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate"
      }
    ],
    "properties": [
      {
        "key": "basic_username",
        "title": "Basic Auth Username",
        "hint": "Leave blank for Azure DevOps PAT authentication",
        "type": "text",
        "required": false,
        "placeholder": ""
      },
      {
        "key": "basic_password",
        "title": "Azure DevOps PAT",
        "hint": "Personal access token; sent as the Basic auth password",
        "type": "password",
        "required": true,
        "placeholder": "Paste PAT"
      },
      {
        "key": "base_url",
        "title": "Organization API URL",
        "hint": "https://dev.azure.com/{organization}",
        "type": "url",
        "required": true,
        "placeholder": "https://dev.azure.com/acme"
      }
    ]
  },
  "bitbucket": {
    "id": "bitbucket",
    "name": "Bitbucket",
    "description": "Manage repositories, pull requests, issues, and Pipelines on Bitbucket Cloud.",
    "category": "Developer Tools",
    "icon": "bitbucket.svg",
    "paid": false,
    "sort": 7,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-02-28",
    "developer": "Atlassian",
    "authType": "credentials",
    "formGuide": "Create a Bitbucket workspace or repository access token for bearer authentication. Atlassian API tokens require HTTP Basic authentication and are documented as a compatibility option below.",
    "installationGuide": {
      "title": "Connect Bitbucket Cloud",
      "description": "Create a least-privilege access token for the Bitbucket Cloud API.",
      "steps": [
        {
          "title": "Choose a token type",
          "content": "In Bitbucket workspace settings, create a repository or workspace access token. Use a repository token for one repository, or a workspace token for shared automation."
        },
        {
          "title": "Choose scopes",
          "content": "Add repository Read for inspection, repository Write for pushes, pullrequests Read for review, pullrequests Write for comments and merges, and pipelines Read or Write as needed."
        },
        {
          "title": "Configure the connection",
          "content": "Enter the access token. The Bitbucket Cloud API base URL is https://api.bitbucket.org/2.0."
        },
        {
          "title": "Save and test",
          "content": "Save the token and test with GET /user or GET /repositories/{workspace} through the proxy."
        }
      ],
      "importantNotes": [
        "Repository and workspace access tokens are sent as bearer tokens and work with the current proxy.",
        "Atlassian API tokens use email plus Basic authentication; the current proxy does not inject Basic credentials. Use an access token or see INTEGRATION.md for the required app change."
      ]
    },
    "features": [
      {
        "title": "Repository Management",
        "description": "Browse repositories, branches, commits, and source files."
      },
      {
        "title": "Pull Requests",
        "description": "Review, comment on, approve, and merge pull requests."
      },
      {
        "title": "Pipelines",
        "description": "Inspect and trigger Bitbucket Pipelines runs."
      }
    ],
    "guideLinks": [
      {
        "title": "Bitbucket Cloud REST API",
        "description": "Bitbucket API 2.0 reference",
        "url": "https://developer.atlassian.com/cloud/bitbucket/rest/intro/"
      },
      {
        "title": "Access Tokens",
        "description": "Bitbucket token permissions and lifecycle",
        "url": "https://support.atlassian.com/bitbucket-cloud/docs/access-tokens/"
      }
    ],
    "properties": [
      {
        "key": "bearer_token",
        "title": "Bitbucket Access Token",
        "hint": "Repository or workspace access token",
        "type": "password",
        "required": true,
        "placeholder": "Paste access token"
      }
    ]
  },
  "cloudflare": {
    "id": "cloudflare",
    "name": "Cloudflare",
    "description": "Manage DNS, Workers, Pages, and CDN settings via the Cloudflare API.",
    "category": "Developer Tools",
    "icon": "cloudflare.svg",
    "paid": true,
    "sort": 9,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-02-28",
    "developer": "Cloudflare"
  },
  "cohere": {
    "id": "cohere",
    "name": "Cohere",
    "description": "Generate text, embed content, and rerank search results with enterprise LLMs.",
    "category": "AI & ML",
    "icon": "cohere.svg",
    "paid": true,
    "sort": 7,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-02-28",
    "developer": "Cohere"
  },
  "forgejo": {
    "id": "forgejo",
    "name": "Forgejo",
    "description": "Manage repositories, issues, pull requests, releases, and organizations on Forgejo, including Codeberg.",
    "category": "Developer Tools",
    "icon": "forgejo.svg",
    "paid": false,
    "sort": 5,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-10-14",
    "developer": "Forgejo",
    "authType": "credentials",
    "formGuide": "Enter a Forgejo or Codeberg URL and a personal access token.",
    "installationGuide": {
      "title": "Connect Forgejo or Codeberg",
      "description": "Create a token and configure the Forgejo-compatible API endpoint.",
      "steps": [
        {
          "title": "Create a token",
          "content": "In Forgejo, open Settings → Applications → Manage Access Tokens and create a token. For Codeberg, use Settings → Applications."
        },
        {
          "title": "Choose permissions",
          "content": "Grant repository read/write, issue, organization, and package permissions only as needed by your automation."
        },
        {
          "title": "Enter the server URL",
          "content": "The default API base URL is https://codeberg.org/api/v1. For another Forgejo server, enter its API URL ending in /api/v1."
        },
        {
          "title": "Save and test",
          "content": "Save the token and test with GET /user through the integration proxy."
        }
      ],
      "importantNotes": [
        "Forgejo's REST API is Gitea-compatible for the endpoints used by this proxy.",
        "Codeberg is the default Forgejo host; self-hosted API URLs override it per account."
      ]
    },
    "features": [
      {
        "title": "Repository Management",
        "description": "Manage repositories, branches, commits, and releases."
      },
      {
        "title": "Issues and Pull Requests",
        "description": "Operate issue and code-review workflows through the Forgejo API."
      },
      {
        "title": "Organizations",
        "description": "Inspect teams, members, and organization repositories."
      }
    ],
    "guideLinks": [
      {
        "title": "Forgejo API Documentation",
        "description": "Forgejo REST API reference",
        "url": "https://forgejo.org/docs/latest/user/api-usage/"
      },
      {
        "title": "Codeberg API",
        "description": "Codeberg API documentation",
        "url": "https://docs.codeberg.org/api/"
      }
    ],
    "properties": [
      {
        "key": "bearer_token",
        "title": "Forgejo Personal Access Token",
        "hint": "Token created in Settings → Applications",
        "type": "password",
        "required": true,
        "placeholder": "Paste token"
      },
      {
        "key": "base_url",
        "title": "Forgejo Server URL",
        "hint": "Codeberg or self-hosted API URL ending in /api/v1",
        "type": "url",
        "required": false,
        "placeholder": "https://codeberg.org/api/v1"
      }
    ]
  },
  "gitea": {
    "id": "gitea",
    "name": "Gitea",
    "description": "Manage repositories, issues, pull requests, releases, and organizations on a self-hosted Gitea server.",
    "category": "Developer Tools",
    "icon": "gitea.svg",
    "paid": false,
    "sort": 4,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-10-14",
    "developer": "Gitea",
    "authType": "credentials",
    "formGuide": "Enter the HTTPS URL of your Gitea server and a personal access token.",
    "installationGuide": {
      "title": "Connect Gitea",
      "description": "Create a Gitea personal access token and point Sulla at your server.",
      "steps": [
        {
          "title": "Create a token",
          "content": "In Gitea, open Settings → Applications → Manage Access Tokens and create a token."
        },
        {
          "title": "Choose permissions",
          "content": "Grant repository read/write, issue, organization, and package permissions only when your workflows need them. Read-only automation can use read permissions."
        },
        {
          "title": "Enter the server URL",
          "content": "Enter the API base URL, such as https://git.example.com/api/v1. The transparent proxy uses this stored URL literally."
        },
        {
          "title": "Save and test",
          "content": "Save the token and test with GET /user through the integration proxy."
        }
      ],
      "importantNotes": [
        "Gitea is self-hosted; the server URL is required for every account.",
        "Use a token with the minimum repository and organization permissions needed."
      ]
    },
    "features": [
      {
        "title": "Repository Management",
        "description": "Manage repositories, branches, commits, and releases."
      },
      {
        "title": "Issues and Pull Requests",
        "description": "Operate issue and code-review workflows through the Gitea API."
      },
      {
        "title": "Organizations",
        "description": "Inspect teams, members, and organization repositories."
      }
    ],
    "guideLinks": [
      {
        "title": "Gitea API Documentation",
        "description": "Gitea REST API v1 reference",
        "url": "https://docs.gitea.com/api/1.24/"
      },
      {
        "title": "Access Tokens",
        "description": "Gitea token management",
        "url": "https://docs.gitea.com/development/api-usage"
      }
    ],
    "properties": [
      {
        "key": "bearer_token",
        "title": "Gitea Personal Access Token",
        "hint": "Token created in Settings → Applications",
        "type": "password",
        "required": true,
        "placeholder": "Paste token"
      },
      {
        "key": "base_url",
        "title": "Gitea Server URL",
        "hint": "HTTPS API URL ending in /api/v1",
        "type": "url",
        "required": true,
        "placeholder": "https://git.example.com/api/v1"
      }
    ]
  },
  "gitlab": {
    "id": "gitlab",
    "name": "GitLab",
    "description": "Manage repositories, CI/CD pipelines, merge requests, issues, and releases on GitLab Cloud or a self-hosted instance.",
    "category": "Developer Tools",
    "icon": "gitlab.svg",
    "paid": false,
    "sort": 2,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-02-28",
    "developer": "GitLab",
    "authType": "credentials",
    "formGuide": "Create a personal access token in GitLab and enter the GitLab URL when connecting a self-hosted instance.",
    "installationGuide": {
      "title": "Connect GitLab",
      "description": "Create a scoped GitLab personal access token for API access.",
      "steps": [
        {
          "title": "Create a token",
          "content": "Go to User settings → Access tokens, name the token, set an expiration date, and create it."
        },
        {
          "title": "Choose scopes",
          "content": "Use api for full repository and merge request automation, or read_api for read-only workflows. Add read_repository or write_repository when your policy requires narrower repository scopes."
        },
        {
          "title": "Configure the instance",
          "content": "Use https://gitlab.com/api/v4 for GitLab Cloud. For self-hosted GitLab, enter its API base URL, for example https://gitlab.example.com/api/v4."
        },
        {
          "title": "Save and test",
          "content": "Save the token and test with GET /user through the integration proxy."
        }
      ],
      "importantNotes": [
        "Tokens are secrets; use the smallest scope and shortest lifetime that fits the job.",
        "Self-hosted API URLs are stored per account and override the shipped GitLab Cloud default."
      ]
    },
    "features": [
      {
        "title": "Repository Management",
        "description": "List projects, inspect repositories, and manage branches and tags."
      },
      {
        "title": "Merge Requests",
        "description": "Review, comment on, and automate merge request workflows."
      },
      {
        "title": "CI/CD and Releases",
        "description": "Inspect pipelines, jobs, deployments, and project releases."
      }
    ],
    "guideLinks": [
      {
        "title": "GitLab REST API",
        "description": "GitLab API v4 reference",
        "url": "https://docs.gitlab.com/api/"
      },
      {
        "title": "Personal Access Tokens",
        "description": "GitLab token creation and scopes",
        "url": "https://docs.gitlab.com/user/profile/personal_access_tokens/"
      }
    ],
    "properties": [
      {
        "key": "bearer_token",
        "title": "GitLab Personal Access Token",
        "hint": "GitLab token with api or read_api scope",
        "type": "password",
        "required": true,
        "placeholder": "glpat-..."
      },
      {
        "key": "base_url",
        "title": "GitLab Base URL",
        "hint": "GitLab Cloud or self-hosted API URL ending in /api/v4",
        "type": "url",
        "required": false,
        "placeholder": "https://gitlab.com/api/v4"
      }
    ]
  },
  "google_drive": {
    "id": "google_drive",
    "name": "Google Drive",
    "description": "Let Sulla read your Google Drive — folders, Docs, Sheets, Slides, PDFs, images and videos. Read-only.",
    "category": "File Storage",
    "icon": "google_drive.svg",
    "paid": false,
    "sort": 1,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.1.0",
    "lastUpdated": "2026-10-13",
    "developer": "Google",
    "authType": "oauth",
    "oauthProviderId": "google",
    "oauthScopes": [
      "https://www.googleapis.com/auth/drive.readonly"
    ],
    "formGuide": "In Google Cloud Console, enable the Google Drive API and create an OAuth client ID of type \"Desktop app\". Paste its Client ID and Secret below, then click \"Connect with Google\". Sulla only asks for read-only access.",
    "properties": [
      {
        "key": "client_id",
        "title": "OAuth Client ID",
        "hint": "Google Cloud Console → APIs & Services → Credentials (type Desktop app)",
        "type": "text",
        "required": true,
        "placeholder": "xxxx.apps.googleusercontent.com"
      },
      {
        "key": "client_secret",
        "title": "OAuth Client Secret",
        "hint": "Google Cloud Console → APIs & Services → Credentials",
        "type": "password",
        "required": true,
        "placeholder": ""
      }
    ]
  },
  "meta-ads": {
    "id": "meta-ads",
    "name": "Meta Ads",
    "description": "Manage Facebook and Instagram ad campaigns, audiences, creatives, and performance insights via the Meta Marketing API.",
    "category": "Paid Ads",
    "icon": "meta_ads.svg",
    "paid": true,
    "sort": 1,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-03-07",
    "developer": "Meta"
  },
  "n8n": {
    "id": "n8n",
    "name": "n8n",
    "description": "Self-hosted workflow automation engine with thousands of integrations and templates.",
    "category": "Automation",
    "icon": "n8n.svg",
    "paid": false,
    "sort": 0,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-03-16",
    "developer": "n8n GmbH",
    "authType": "credentials",
    "installationGuide": {
      "title": "Connect n8n",
      "description": "Connect your local n8n automation engine to enable workflow management through the integration API.",
      "steps": [
        {
          "title": "Open n8n Settings",
          "content": "Navigate to Settings → API in your n8n instance."
        },
        {
          "title": "Create API Key",
          "content": "Click \"Create API Key\" and copy the generated key."
        },
        {
          "title": "Paste Key Here",
          "content": "Paste the API key into the field above and save."
        }
      ]
    },
    "properties": [
      {
        "key": "api_key",
        "title": "API Key",
        "hint": "n8n API key (Settings → API → Create API Key)",
        "type": "password",
        "required": true,
        "placeholder": "n8n-api-..."
      },
      {
        "key": "base_url",
        "title": "Base URL",
        "hint": "n8n instance URL (default: http://127.0.0.1:30119)",
        "type": "url",
        "required": false,
        "placeholder": "http://127.0.0.1:30119"
      }
    ]
  },
  "openai": {
    "id": "openai",
    "name": "OpenAI",
    "description": "Connect OpenAI models for chat, reasoning, and multimodal generation.",
    "category": "AI Infrastructure",
    "icon": "openai.svg",
    "paid": true,
    "sort": 4,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-02-28 11:42:00",
    "developer": "OpenAI",
    "oauth": true,
    "oauthProviderId": "openai",
    "formGuide": "Paste your OpenAI API key or sign in with OAuth for unlimited access via your ChatGPT Plus/Pro subscription.",
    "properties": [
      {
        "key": "api_key",
        "title": "OpenAI API Key",
        "hint": "Generate this in your OpenAI dashboard.",
        "type": "password",
        "required": true,
        "placeholder": "sk-..."
      },
      {
        "key": "model",
        "title": "Model",
        "hint": "Select an OpenAI model to use for completions.",
        "type": "select",
        "required": true,
        "placeholder": "Select a model...",
        "selectBoxId": "openai_models",
        "selectDependsOn": [
          "api_key"
        ]
      }
    ]
  },
  "r2": {
    "id": "r2",
    "name": "Cloudflare R2",
    "description": "Manage S3-compatible object storage with zero egress fees on Cloudflare.",
    "category": "File Storage",
    "icon": "r2.svg",
    "paid": true,
    "sort": 15,
    "beta": false,
    "comingSoon": false,
    "connected": false,
    "version": "1.0.0",
    "lastUpdated": "2026-02-28",
    "developer": "Cloudflare"
  }
};
