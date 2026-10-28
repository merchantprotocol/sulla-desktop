# Integration packages

An integration is executable, versioned package code. It is not an editable database row and it is not discovered from arbitrary loose files. The Marketplace installer verifies the downloaded archive, signature and package integrity before making a version available to the integration loader.

Built-in integrations use the same package loader. Their package entry is compiled into Sulla Desktop and their signature trust comes from the signed app bundle. Third-party packages require a Marketplace publisher signature and a user grant before first use.

## Package layout

```text
acme/
  integration.yaml
  src/acme.entry.js
  endpoints/items.yaml
  README.md
```

`integration.yaml` uses Extension Contract v1 field names (`sullaApi` and `permissions`):

```yaml
apiVersion: sulla/v1
kind: integration
id: acme
version: 1.2.0
sullaApi: ^1.0.0
permissions:
  - network:api.acme.example
entry: src/acme.entry.js
integrity: sha256:REPLACED_BY_PACKAGER
signature:
  algorithm: ed25519
  keyId: marketplace-publisher-key-id
  value: BASE64_SIGNATURE_OVER_INTEGRITY
auth:
  type: oauth2
  scopes: [items.read]
baseUrls:
  - https://api.acme.example
tools:
  - name: list_items
    endpoint: /v1/items
proxyPaths:
  - method: GET
    path: /v1/items
```

The integrity value is SHA-256 over the canonical manifest (excluding `integrity` and `signature`) plus the name and SHA-256 digest of every package file. The Ed25519 publisher signature covers that integrity value. A changed manifest, entry or endpoint file therefore fails installation/loading.

## Runtime security model

An entry receives an immutable integration runtime API with one operation: `proxy({ method, path, body })`. The loader refuses paths not declared in `proxyPaths`. The proxy selects the connected account, obtains a signed credential scope and asks the vault broker to inject OAuth/API-key material into the outbound request. Raw tokens, API keys, the vault service and environment variables are never passed to package code.

The package declares auth metadata, but never stores credentials:

- `none`: public endpoint
- `apiKey`: API key held by the vault
- `bearer`: bearer token held by the vault
- `oauth2`: OAuth token held/refreshed by the vault; `auth.scopes` is the requested grant
- `mcp`: calls route through `MCPBridge`; the bridge uses its account-scoped broker context

On first use, Sulla compares `permissions`, `baseUrls`, OAuth scopes, tools and proxy paths with the saved grant. No grant means no load. An update that expands requested access requires a new grant.

## Installing and publishing

Use the existing Marketplace surface:

```bash
sulla marketplace/validate '{"kind":"integration","slug":"acme"}'
sulla marketplace/publish '{"kind":"integration","slug":"acme"}'
sulla marketplace/download '{"kind":"integration","slug":"acme"}'
```

Validation must succeed before publication. Installation is transactional: download to staging, verify archive signature and hash, validate the manifest and declared entry, then activate the version. Verification failure leaves the prior version active.

### Marketplace review signing

After review approves the exact package bytes, the Marketplace service computes the canonical `integrity` value, signs that UTF-8 value with its offline Ed25519 private key, and writes the key id and base64 signature into the manifest. Desktop ships only the matching public keys in `resources/trusted-integration-publishers.json`; private keys must never enter this repository or a Desktop build.

**Jonathon key-custody step:** create the production Ed25519 signing key in the Marketplace release environment/HSM, retain and back up the private key there, and publish only its PEM public key plus key id in the trusted-publisher file. Until that public key is added, third-party packages correctly fail closed as untrusted.

## Example entry

```js
export default function acme(runtime) {
  return {
    listItems() {
      return runtime.proxy({ method: 'GET', path: '/v1/items' })
    }
  }
}
```

The example cannot import or request vault credentials. Its only outbound route is the declared proxy path.
