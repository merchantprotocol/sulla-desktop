---
slug: sulla-build-an-integration-package
label: Build a signed Sulla integration package
trigger_when: When executable integration catalog code needs authenticated API access through Sulla's broker, exact proxy routes, integrity verification, publisher signing, and an install grant.
trigger_actions: [build integration package, sign integration, declare proxy paths, test brokered API]
trigger_phrases: [signed integration package, proxyPaths, trusted publisher, Ed25519 integration, brokered integration]
scope: [sulla-plugins, sulla-extensions, sulla-marketplace]
---

**When:** Use an ordinary integration manifest for normal REST or MCP auth and endpoints. Use this signed package boundary only when package entry code must define an integration catalog object and call brokered API routes without receiving vault credentials.

**Do:**
1. First scaffold the ordinary integration shape: `sulla marketplace/scaffold '{"kind":"integration","slug":"acme","name":"Acme","description":"Reads Acme records"}'`. It creates `INTEGRATION.md`, `acme.v1-auth.yaml`, and an endpoint file. Validate it with `sulla marketplace/validate '{"kind":"integration","slug":"acme"}'`.
2. For the signed package, create a package manifest and the declared entry file. The entry file must parse as YAML or JSON and declare an integration object whose `id`, `name`, and `description` are present; its `id` must match the package manifest.
3. Use this minimum envelope, then narrow every value:

```yaml
apiVersion: sulla/v1
kind: integration
id: acme
version: 1.0.0
sullaApi: ^1.0.0
permissions: [records.read]
entry: integration.yaml
integrity: sha256:<canonical-package-hash>
signature:
  algorithm: ed25519
  keyId: acme-publisher-1
  value: <base64-signature-over-the-integrity-string>
auth:
  type: oauth2
  scopes: [records.read]
baseUrls: [https://api.acme.example]
proxyPaths:
  - {method: GET, path: /v1/records}
tools:
  - {name: list_records, endpoint: /v1/records}
```

4. `id` must match `^[a-z][a-z0-9_-]*$`; `version` must begin with semantic `major.minor.patch`; `entry` must exist in the package; base URLs must use HTTPS except `localhost` or `127.0.0.1`; proxy and tool paths must begin with `/` and contain no traversal or backslashes.
5. The package hash is `sha256:` plus SHA-256 of stable JSON containing the manifest without `integrity` and `signature`, and a filename-sorted map of each package file to its SHA-256 hex digest. Stable JSON sorts object keys recursively. Sign the literal integrity string with the Ed25519 private key and base64-encode the signature.
6. Never include the private signing key. The matching public key must be enabled in the app-bundled `resources/trusted-integration-publishers.json` under the same `keyId`. The shipped file can contain zero keys; when no enabled trusted key exists, third-party signed packages intentionally cannot install.
7. Request only the exact permission set and routes. A grant is keyed by `id@version` and matches the sorted permissions exactly. Changing version or permissions requires a new grant. First-party app-bundled packages alone bypass the user grant.
8. Package entry code receives only `runtime.proxy({method,path,body})`. It receives no vault API or credential material. The loader rejects a method/path pair not listed in `proxyPaths`, even when its base URL is allowed.
9. Validate the ordinary integration artifact with `marketplace/validate`. Before submission, independently recompute the canonical hash, verify the Ed25519 signature with the intended public key, parse the entry, and confirm mismatched integrity, untrusted keys, missing grants, HTTP remote URLs, and undeclared proxy paths all fail closed.
10. Publish the reviewed Files draft and wait for Decide approval. Signed packages installed through the marketplace are verified before immutable persistence in the `integration_packages` table; the runtime re-verifies them when loading. An installed but ungranted package appears as needing approval instead of executing.
11. Test with a fixture or test account. Call one declared read route and confirm the expected structured result. Then attempt a harmless undeclared route and confirm rejection. Inspect logs only for status and redacted errors; never print headers or credentials.
12. Prepare the marketplace submission and use the exact approval card from `sulla-build-a-plugin`. Only after **Approve**, submit and verify `marketplace/list_published` reports `pending`.

**Check:** Canonical integrity and signature verify, the publisher key is trusted, the exact permission grant exists, a declared route works through the broker, and an undeclared route fails.

**Don't:** call direct HTTP from entry code, read environment or vault secrets, use wildcard proxy routes, sign mutable output, ship a private key, or claim third-party installation works while the trusted-key list is empty.
